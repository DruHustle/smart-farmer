import type { PoolClient } from "pg";

/** Preserve the original scope, authorizer and dates when recorded material moves.
 * Callers lock source and destination projects in ID order before this copy. */
export async function propagateRestrictions(
  client: PoolClient,
  farmId: string,
  sourceId: string,
  targetId: string,
  actorId: string,
) {
  if (sourceId === targetId) return;
  await client.query(
    `INSERT INTO treatment_restrictions(id,farm_id,project_id,source_project_id,starts_at,ends_at,scope,reason,authorized_by,created_by,origin_restriction_id)
 SELECT gen_random_uuid(),r.farm_id,$3,$2,r.starts_at,r.ends_at,r.scope,r.reason,r.authorized_by,$4,COALESCE(r.origin_restriction_id,r.id)
 FROM treatment_restrictions r WHERE r.farm_id=$1 AND r.project_id=$2 AND r.ends_at>clock_timestamp()
 AND NOT EXISTS(SELECT 1 FROM treatment_restrictions x WHERE x.farm_id=$1 AND x.project_id=$3 AND x.origin_restriction_id=COALESCE(r.origin_restriction_id,r.id))`,
    [farmId, sourceId, targetId, actorId],
  );
}
