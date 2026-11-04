# Operational API contract (completion work)

All paths are under `/v1/farms/:farmId` unless stated otherwise. Bearer authentication and current farm membership are always required; owner/manager actions are marked M, owner-only actions O. IDs are client UUIDs. Create requests retain the same ID across retries. Lists return `{items,nextCursor}` with `limit` (1–100), `cursor`. Dates are ISO instants; units stay explicit. JSON resource rows use snake_case database fields; requests use camelCase. Mutations returning a versioned resource return the row. Unknown provider/device state is explicit.

## Farm context

- `GET/POST /locations`: members read; M creates `{id,name,kind:"plot"|"house"|"pond"|"tank"|"store"|"other",parentId?,areaHa?,latitude?,longitude?,note?}`. `PATCH /locations/:id`: M `{version,...editableFields,reason}`.
- `GET /settings`: `{timezone,weatherEnabled,latitude,longitude,fishHatcheryEnabled,mediaRetentionDays,cameraRetentionDays,aiEnabled,dataSharingEnabled}`. `PATCH /settings`: O same camelCase fields plus `confirmed:true`; unknown coordinates remain null. External AI/weather require explicit enabling. Cross-farm training/data sharing defaults false and is never implied by AI use.
- `GET /provider-status`: `{weather,ai,media,push,email,sms,camera,transports}`. Each entry has `configured`, `mode`, `requirements` identifiers. Clients translate these identifiers. No secrets are returned.

## Weather and measured observations

- `GET /weather`: `{forecast:null|{provider,sourceUrl,fetchedAt,validFrom,timezone,hourly},observations,configured,stale}`. Forecasts remain distinct from field measurements.
- `POST /weather/refresh`: M fetches configured Open-Meteo forecast using the farm's confirmed coordinates; response is the same weather object. No configured coordinates/provider -> `weather_unconfigured`.
- `GET/POST /weather/observations`: recorders create `{id,kind:"rainfall"|"temperature"|"humidity"|"wind"|"soil_moisture"|"water_level",value,unit,observedAt,locationId?,source:"manual"|"gauge",instrument?,calibration?,note?}`. Response includes source and both timestamps.

## Notifications

- `GET /notifications`: only this user's farm inbox; fields `id,kind,message_key,arguments,created_at,acknowledged_at,delivery_state,entity_type,entity_id`.
- `POST /notifications/:id/ack`: `{}`; acknowledges this user's notification, independent of delivery state.
- `GET/PATCH /notification-preferences`: `{inApp,push,email,sms,quietStart:null|"HH:MM",quietEnd:null|"HH:MM"}`. Language follows account preference, schedules use farm timezone.
- `GET /notification-channels`: current user's masked addresses and verification/delivery states.
- `POST /notification-channels`: `{id,channel:"push"|"email"|"sms",address}`. Push uses the device-issued Expo token; email/SMS start ownership verification only through a configured provider. Returns `{id,state,verificationRequired}`. Disabled providers never claim delivery; codes are exposed only in an explicit test environment.
- `POST /notification-channels/:id/verify`: `{code}`; `DELETE /notification-channels/:id` removes only current user's channel.
- `POST /notifications`: M `{id,audience:"managers"|"members"|"assignee",userId?,kind:"reminder"|"incident"|"maintenance",title,note?,dueAt?}`. User text is preserved, not silently translated.

Task assignments, due work, incidents, equipment/camera alerts and maintenance produce deduplicated inbox items. Provider acceptance, provider delivery, failed/unknown outcomes and user acknowledgement remain separate. Test mode does not send real messages.

## Assets, maintenance and manual usage

Existing asset read/create/command routes remain compatible. Asset rows additionally expose `version,make,controller,firmware,location_id,responsible_id,integration_state,configuration,notes`.

- `PATCH /assets/:id`: M `{version,name?,make?,model?,controller?,firmware?,locationId?,responsibleId?,notes?,staleAfterSeconds?,reason}`.
- `POST /assets/:id/integration`: O `{version,protocol:"simulator"|"mqtt"|"http"|"modbus",telemetry:[{name,unit,address,scale?,offset?}],commands:[{name:"start"|"stop",address,value}],connectionRef,reason}`. Connection reference names a private edge configuration, never a browser-visible password or device URL. Changes revoke verification and cannot turn on unknown hardware.
- `POST /assets/:id/commissioning`: O `{id,version,mode:"read_only"|"control",checks:{identityVerified,mappingVerified,localInterlocksVerified,manualOverrideVerified,networkLossVerified,feedbackVerified},evidence,confirmed:true,password}`. Control requires a known model, approved mapping, all checks and fresh real feedback. Simulator checks do not commission physical hardware.
- `GET/POST /assets/:id/maintenance`: M creates `{id,title,dueAt,intervalDays?,instructions?,assigneeId?,projectId?}`.
- `PATCH /maintenance/:id`: M `{version,status:"completed"|"cancelled",note,performedAt?,hours?,amount?,currency?}`. Completion records any declared expense once; recurring plans create the next occurrence once.
- `GET/POST /assets/:id/usage`: recorders create `{id,kind:"runtime"|"fuel"|"energy"|"water"|"pressure"|"position"|"fault",quantity,unit,observedAt,projectId?,note?}`. These are observations; fuel stock consumption remains the linked input-use workflow.
- `GET /assets/:id/telemetry`: paginated typed observations `{measurement,value,unit,observed_at,received_at,source,quality}` alongside legacy simulator telemetry.

## Farm security

Manager/owner camera access is default. Other members require an explicit camera grant.

- `GET /cameras`: permitted assets with `id,name,connection_state,live_enabled,retention_days,last_frame_at,capabilities`.
- `POST /cameras/:id/configure`: O `{version,provider:"simulator"|"gateway",retentionDays,eventsEnabled,liveEnabled}`.
- `GET/POST /cameras/:id/access`: O grants `{userId}`; `DELETE /cameras/:id/access/:userId` revokes.
- `POST /cameras/:id/sessions`: `{confirmed:true}` returns `{id,token,expiresAt,playlistPath,connectionState,mode}`. Short-lived token is camera-session scoped. HLS fetches use `Authorization: Bearer <session token>`; credentials are never embedded in a public URL. Web uses an authenticated HLS loader; native video uses request headers. Unconnected cameras return `camera_unavailable`.
- `GET /camera-events` and existing event acknowledgement remain; event rows can include `clip_available`. `POST /camera-events/:id/session` creates an authorised playback session for its retained segments.

The gateway posts typed telemetry, camera segments and detected events through per-asset credentials. Simulated imagery and simulated detections are labelled. Motion is never relabelled as a person detection.

## Companion and reference material

- Existing GET project Companion remains record-based and is completed by the product module.
- `GET/POST /references`: members read; M creates `{id,title,sourceUrl,publishedOn,version,language:"sn"|"nd",content,reviewedBy}`. Source/date/version and reviewer statement are preserved; no fabricated native-speaker endorsement.
- `POST /projects/:id/companion/chat`: `{question,referenceIds:[],language:"sn"|"nd"}` -> `{mode:"model"|"record_based",provider,answer,limitations,referenceIds,proposals:[]}`. AI needs explicit farm opt-in plus server credentials, and has no tool authority. Missing provider returns deterministic context with honest mode.

## Media and retention

Private-media uploads accept exactly one `activityId` or `assetId`, with optional `financial` classification. This supports equipment photographs, voice notes, manuals and receipts without inventing an activity. PDFs and supported image/audio formats are bounded to 5 MiB. Financial evidence requires management; camera-asset evidence requires camera permission; advisers may attach their own non-financial evidence. Both parent and permissions are checked again on an idempotent replay and download. Complete schema is in [integrations-api.md](integrations-api.md).

Object storage is selected server-side (`file` or `s3`); clients never receive bucket credentials. `GET /media-policy` returns quota/usage/retention and provider mode. `PATCH /media-policy`: O `{retentionDays:null|integer,confirmed:true}`. Null retains ordinary field evidence indefinitely. Expiry is audited and garbage collection respects active backup locks. Camera segments use the separate camera policy. Production off-host encrypted backup configuration and scheduled restore checks live under backend operations tooling.


### Recovery and camera follow-up additions

`POST /notification-channels/:channelId/resend` requests a fresh verification code for the current user's unverified or disabled channel, after a 60-second cooldown. It returns the same verification-required response as registration; simulation-only codes never appear in live mode. `PATCH /notification-preferences` returns the same camelCase fields as GET. Re-registering an existing address returns its original channel ID.

`POST /camera-events/:eventId/incident` accepts `{id,title,description,severity,assigneeId,confirmed:true}`. The reviewed title/description become a farm-visible incident; camera credentials or private metadata are not copied automatically. Current camera viewers with owner, manager or worker permission can raise it; assignment to another worker requires manager permission. Event rows include `incident_id`. Unacknowledged events escalate once to managers after five minutes. Acknowledgement marks the event's queued inbox alerts acknowledged and prevents escalation.

`GET /cameras/:assetId/snapshot` queues an on-demand gateway capture and returns the latest recent snapshot if available, with `X-Observed-At` and `X-Media-Source`; a client can retry while capture is pending. These headers are exposed through CORS. Simulation images are labeled explicitly.

`GET /media` accepts `cursor` and `limit` in addition to either `activityId` or `assetId`, returning `items` and `nextCursor`. Media policy adds `pendingDeletionBytes` and `cameraPendingDeletionBytes`; quotas include pending-deletion objects until the worker confirms removal.

Gateway camera demand includes the farm `timezone` for local schedule enforcement. `/edge/camera/segments` accepts optional `discontinuity:boolean` (default false); set it on the first segment of a new encoder capture. With configured detection zones, events without an explicitly mapped zone return `ignored_unmapped_zone`. Gateways must discard associated footage rather than present it as an accepted event.
