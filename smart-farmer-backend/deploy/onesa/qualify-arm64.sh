#!/usr/bin/env bash
# Qualify local images on native ARM64, using only a disposable internal network.
set -euo pipefail
umask 077
receipt=${1:?Usage: qualify-arm64.sh /private/new-image-receipt.env}
if [[ -e "$receipt" || -L "$receipt" ]]; then echo 'Choose a new image receipt path' >&2; exit 2; fi
case "$(docker info --format '{{.Architecture}}')" in aarch64|arm64) ;; *) echo 'A native ARM64 Docker server is required' >&2; exit 2;; esac
repo=$(git rev-parse --show-toplevel)
revision=$(git -C "$repo" rev-parse HEAD)
temp=$(mktemp -d)
run=farmer-check-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
network= media= keep_images=false
containers=(); tags=()
cleanup() {
  for id in "${containers[@]}"; do docker rm --force "$id" >/dev/null || true; done
  if [[ -n "$media" ]]; then docker volume rm "$media" >/dev/null || true; fi
  if [[ -n "$network" ]]; then docker network rm "$network" >/dev/null || true; fi
  if [[ "$keep_images" != true ]]; then
    for tag in "${tags[@]}"; do docker image rm "$tag" >/dev/null || true; done
  fi
  rm -rf -- "$temp"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# The private parent protects the checkout. Preserve tracked input modes in the
# build contexts, including nginx.conf, which the web image reads as UID 101.
git -C "$repo" -c tar.umask=0022 archive "$revision" -- smart-farmer-backend smart-farmer-frontend/web |
  tar --no-same-owner --same-permissions -x -C "$temp"
backend="$temp/smart-farmer-backend"
web="$temp/smart-farmer-frontend/web"
builder=()
if [[ -n ${FARMER_BUILDER:-} ]]; then builder=(--builder "$FARMER_BUILDER"); fi
declare -A images
build_image() {
  local kind=$1 context=$2 file=$3 tag details
  shift 3
  tag="smart-farmer-${kind}:${run}"
  tags+=("$tag")
  docker buildx build "${builder[@]}" --load --platform linux/arm64 --provenance=false \
    --label "org.opencontainers.image.revision=$revision" --file "$file" --tag "$tag" "$@" "$context"
  images[$kind]=$(docker image inspect --format '{{.Id}}' "$tag")
  details=$(docker image inspect --format '{{.Os}}/{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "${images[$kind]}")
  [[ "$details" == "linux/arm64 $revision" ]] || { echo "Unexpected $kind image identity" >&2; exit 1; }
}
build_image api "$backend" "$backend/Dockerfile" --build-arg "APP_REVISION=$revision"
build_image web "$web" "$web/Dockerfile" --build-arg "APP_REVISION=$revision" --build-arg VITE_API_URL=https://farmer.onesa.eu
build_image db "$backend" "$backend/Dockerfile.database"
build_image backup "$backend" "$backend/Dockerfile.backup"

network=$(docker network create --internal "$run")
media=$(docker volume create "${run}-media")
export POSTGRES_PASSWORD
POSTGRES_PASSWORD=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
export PGHOST=db PGUSER=postgres PGDATABASE=postgres PGPASSWORD="$POSTGRES_PASSWORD"
db_env=(-e PGHOST -e PGUSER -e PGDATABASE -e PGPASSWORD)
app_env=("${db_env[@]}" -e WEB_ORIGIN=https://farmer.onesa.eu -e MEDIA_ROOT=/data/media)
mount=(--mount "type=volume,source=$media,target=/data/media")
start() {
  container=$(docker run -d --network "$network" "$@")
  containers+=("$container")
}
wait_ok() {
  local service=$1 id=$2 try state
  shift 2
  echo "Checking $service"
  for try in {1..60}; do
    if docker exec "$id" "$@" >"$temp/probe.log" 2>&1; then return; fi
    state=$(docker inspect --format '{{.State.Status}}' "$id")
    [[ "$state" == running ]] || break
    sleep 1
  done
  echo "$service readiness failed" >&2
  docker inspect --format 'state={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}' "$id" >&2
  tail -n 12 "$temp/probe.log" >&2
  docker logs --tail 25 "$id" >&2
  return 1
}
start --network-alias db --memory 448m --tmpfs /var/lib/postgresql/data:rw,size=192m -e POSTGRES_PASSWORD "${images[db]}"
db=$container
wait_ok postgres "$db" pg_isready -h 127.0.0.1 -U postgres
docker run --rm --network "$network" "${db_env[@]}" "${images[api]}" node dist/migrate.js
start --memory 384m --read-only --tmpfs /tmp "${app_env[@]}" "${mount[@]}" "${images[api]}"
api=$container
wait_ok api "$api" node -e "fetch('http://127.0.0.1:3000/ready').then(r => process.exit(r.ok ? 0 : 1))"
start --memory 256m --read-only --tmpfs /tmp "${app_env[@]}" "${mount[@]}" "${images[api]}" node dist/worker.js
wait_ok worker "$container" node dist/worker-health.js
start --memory 96m --read-only --tmpfs /tmp:mode=1777 --cap-drop ALL --security-opt no-new-privileges "${images[web]}"
web_id=$container
wait_ok web "$web_id" wget -qO /dev/null http://127.0.0.1:8080/healthz
docker exec "$web_id" wget -qO - http://127.0.0.1:8080/release.json | python3 -c 'import json,sys; assert json.load(sys.stdin)["revision"] == sys.argv[1]' "$revision"

docker exec -i "$api" node --input-type=module - "$revision" <<'JS'
import assert from 'node:assert/strict'
const base='http://127.0.0.1:3000'
assert.equal((await (await fetch(base+'/version')).json()).revision,process.argv[2])
async function post(route, body, expected, token) {
  const headers={'Content-Type':'application/json'}
  if(token) headers.Authorization='Bearer '+token
  const response=await fetch(base+route,{method:'POST',headers,body:JSON.stringify(body)})
  assert.equal(response.status,expected,route)
  return response.json()
}
const account={username:'arm64fixture',password:'disposable-arm64-fixture'}
const {farmId}=await post('/v1/register',{...account,language:'sn',farmName:'ARM64 fixture'},201)
const {token}=await post('/v1/sessions',account,200)
const dataBase64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD0cAAAAASUVORK5CYII='
await post('/v1/farms/'+farmId+'/accounting/documents',{id:crypto.randomUUID(),mimeType:'image/png',filename:'fixture.png',dataBase64},201,token)
JS

docker exec "$db" createdb -U postgres smart_farmer_restore_arm64
export DATABASE_URL="postgresql://postgres:$POSTGRES_PASSWORD@db/postgres"
export RESTORE_DATABASE_URL="postgresql://postgres:$POSTGRES_PASSWORD@db/smart_farmer_restore_arm64"
docker run --rm --network "$network" --memory 320m --read-only --tmpfs /tmp:rw,mode=1777,size=128m \
  --mount "type=volume,source=$media,target=/data/media,readonly" -e DATABASE_URL -e RESTORE_DATABASE_URL \
  -e MEDIA_ROOT=/data/media -e BACKUP_KEY_FILE=/tmp/backup.key --entrypoint sh "${images[backup]}" -ec '
    umask 077
    head -c 32 /dev/urandom > /tmp/backup.key
    node scripts/backup.mjs create --output /tmp/fixture.sfbak
    node scripts/backup.mjs restore --archive /tmp/fixture.sfbak --media-dir /tmp/restore --confirm-empty-target >/tmp/restore.json
    node -e "const r=require(process.argv[1]); if(r.status!==process.argv[2] || r.verifiedMediaFiles!==1)process.exit(1)" /tmp/restore.json restored_to_isolated_target
  '
restored=$(docker exec "$db" psql -U postgres -d smart_farmer_restore_arm64 -Atc "SELECT count(*) FROM users WHERE username='arm64fixture'")
[[ "$restored" == 1 ]] || { echo 'Restored fixture account missing' >&2; exit 1; }
( set -o noclobber
  printf 'FARMER_SOURCE_REVISION=%s\nFARMER_API_IMAGE=%s\nFARMER_WEB_IMAGE=%s\nFARMER_DB_IMAGE=%s\nFARMER_BACKUP_IMAGE=%s\n' \
    "$revision" "${images[api]}" "${images[web]}" "${images[db]}" "${images[backup]}" > "$receipt"
)
keep_images=true
cat "$receipt"
