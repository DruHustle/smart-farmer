# Smart Farmer-only Activepieces business workflows

**Optional and not connected or deployed by this PR.** Farm automation should
orchestrate human-facing reminders, incident escalation, supplies, equipment
service requests, marketplace enquiries and approved reports. It must not
control borehole/pump/pivot safety logic.

Use a completely independent Smart Farmer Activepieces release, PostgreSQL,
Redis, keys, storage, ingress and operation/backup policy. No shared IMSOP,
Smart Factory or Onesa runtime. The \`values.example.yaml\` file is a Helm
**candidate**, not a production-qualified release; bind a reviewed official
chart version and replace all placeholders through a private secret manager.

Official chart and setup:
https://www.activepieces.com/docs/install/options/helm

Upstream self-hosted Compose guidance currently calls for at least 2 vCPU and
4 GiB RAM. Measure available memory before deploying to the Onesa Oracle VM.

No raw farm photos, livestock health data or equipment access credentials may
be forwarded to generic external automation flows. Preserve backend
authorization and audit; any AI result is advisory only. For now the Farm
edge-to-API path works without Activepieces and no business flow is falsely
reported as running.
