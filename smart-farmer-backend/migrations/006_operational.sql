-- Operational integrations, private camera transport and durable notifications.
CREATE TABLE farm_locations (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), name text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('plot','house','pond','tank','store','other')),
 parent_id uuid, area_ha numeric(18,6) CHECK(area_ha>0), latitude numeric CHECK(latitude BETWEEN -90 AND 90), longitude numeric CHECK(longitude BETWEEN -180 AND 180),
 description text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1, created_by uuid NOT NULL REFERENCES users(id), payload_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(farm_id,id),
 CHECK((latitude IS NULL)=(longitude IS NULL)), CHECK(parent_id IS NULL OR parent_id<>id), FOREIGN KEY(farm_id,parent_id) REFERENCES farm_locations(farm_id,id)
);
ALTER TABLE projects ADD CONSTRAINT projects_location_fk FOREIGN KEY(farm_id,location_id) REFERENCES farm_locations(farm_id,id);
ALTER TABLE stock_items ADD CONSTRAINT stock_location_fk FOREIGN KEY(farm_id,location_id) REFERENCES farm_locations(farm_id,id);
ALTER TABLE farms ADD COLUMN operations_settings jsonb NOT NULL DEFAULT '{}';
CREATE TABLE weather_observations (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), location_id uuid,
 actor_id uuid NOT NULL REFERENCES users(id), kind text NOT NULL, value numeric NOT NULL, unit text NOT NULL,
 source text NOT NULL CHECK(source IN ('manual','gauge')), instrument text, calibration text, note text NOT NULL DEFAULT '',
 observed_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(), payload_hash text NOT NULL,
 FOREIGN KEY(farm_id,location_id) REFERENCES farm_locations(farm_id,id)
);
CREATE INDEX weather_farm_time ON weather_observations(farm_id,observed_at DESC,id);
CREATE TABLE weather_forecasts (farm_id uuid PRIMARY KEY REFERENCES farms(id), provider text NOT NULL, source_url text NOT NULL, fetched_at timestamptz NOT NULL, data jsonb NOT NULL);
CREATE TABLE reference_material (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), title text NOT NULL, source_url text NOT NULL, published_on date NOT NULL,
 version text NOT NULL, language text NOT NULL CHECK(language IN ('sn','nd')), content text NOT NULL, reviewed_by text NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), payload_hash text NOT NULL
);
CREATE TABLE companion_interactions (id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), project_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES users(id), provider text NOT NULL, reference_ids uuid[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(farm_id,project_id) REFERENCES projects(farm_id,id));
ALTER TABLE assets DROP CONSTRAINT assets_integration_state_check;
ALTER TABLE assets ADD CONSTRAINT assets_integration_state_check CHECK(integration_state IN ('unconfigured','simulated','connected-awaiting-verification','verified-read-only','verified-control-enabled','offline','degraded'));
ALTER TABLE assets ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE assets ADD COLUMN make text;
ALTER TABLE assets ADD COLUMN controller text;
ALTER TABLE assets ADD COLUMN firmware text;
ALTER TABLE assets ADD COLUMN location_id uuid;
ALTER TABLE assets ADD COLUMN responsible_id uuid REFERENCES users(id);
ALTER TABLE assets ADD COLUMN notes text NOT NULL DEFAULT '';
ALTER TABLE assets ADD COLUMN configuration jsonb NOT NULL DEFAULT '{}';
ALTER TABLE assets ADD COLUMN configuration_hash text;
ALTER TABLE assets ADD COLUMN last_real_feedback_at timestamptz;
ALTER TABLE assets ADD CONSTRAINT asset_location_fk FOREIGN KEY(farm_id,location_id) REFERENCES farm_locations(farm_id,id);
CREATE TABLE asset_commissioning (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), asset_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), mode text NOT NULL CHECK(mode IN ('read_only','control')), checks jsonb NOT NULL,
 evidence text NOT NULL, configuration_hash text NOT NULL, payload_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(farm_id,asset_id) REFERENCES assets(farm_id,id)
);
CREATE TABLE asset_observations (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL, asset_id uuid NOT NULL, measurement text NOT NULL, value jsonb NOT NULL, unit text NOT NULL,
 observed_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), source text NOT NULL CHECK(source IN ('simulator','gateway','manual')),
 quality text NOT NULL CHECK(quality IN ('good','uncertain','bad')), payload_hash text NOT NULL, FOREIGN KEY(farm_id,asset_id) REFERENCES assets(farm_id,id)
);
CREATE INDEX asset_observations_history ON asset_observations(farm_id,asset_id,observed_at DESC,id);
CREATE TABLE asset_usage (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL, asset_id uuid NOT NULL, project_id uuid, actor_id uuid NOT NULL REFERENCES users(id),
 kind text NOT NULL, quantity numeric NOT NULL CHECK(quantity>=0), unit text NOT NULL, observed_at timestamptz NOT NULL,
 source text NOT NULL DEFAULT 'manual', note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), payload_hash text NOT NULL,
 FOREIGN KEY(farm_id,asset_id) REFERENCES assets(farm_id,id), FOREIGN KEY(farm_id,project_id) REFERENCES projects(farm_id,id)
);
CREATE TABLE asset_maintenance (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL, asset_id uuid NOT NULL, project_id uuid, actor_id uuid NOT NULL REFERENCES users(id),
 title text NOT NULL, due_at timestamptz NOT NULL, interval_days integer CHECK(interval_days BETWEEN 1 AND 3650), instructions text NOT NULL DEFAULT '',
 assignee_id uuid REFERENCES users(id), status text NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','completed','cancelled')), version integer NOT NULL DEFAULT 1,
 performed_at timestamptz, hours numeric CHECK(hours>=0), amount numeric(18,2) CHECK(amount>=0), currency text, note text NOT NULL DEFAULT '',
 next_occurrence_id uuid, created_at timestamptz NOT NULL DEFAULT now(), payload_hash text NOT NULL,
 FOREIGN KEY(farm_id,asset_id) REFERENCES assets(farm_id,id), FOREIGN KEY(farm_id,project_id) REFERENCES projects(farm_id,id), CHECK((amount IS NULL)=(currency IS NULL))
);
CREATE TABLE notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid NOT NULL REFERENCES farms(id), user_id uuid NOT NULL REFERENCES users(id),
 kind text NOT NULL, message_key text NOT NULL, arguments jsonb NOT NULL DEFAULT '{}', entity_type text, entity_id uuid,
 dedupe_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), acknowledged_at timestamptz,
 UNIQUE(farm_id,user_id,dedupe_key)
);
CREATE INDEX notification_inbox ON notifications(farm_id,user_id,created_at DESC,id);
CREATE TABLE notification_requests (id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), actor_id uuid NOT NULL REFERENCES users(id), payload_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE notification_preferences (
 farm_id uuid NOT NULL REFERENCES farms(id), user_id uuid NOT NULL REFERENCES users(id), in_app boolean NOT NULL DEFAULT true, push boolean NOT NULL DEFAULT false,
 email boolean NOT NULL DEFAULT false, sms boolean NOT NULL DEFAULT false, quiet_start text, quiet_end text, PRIMARY KEY(farm_id,user_id), CHECK((quiet_start IS NULL)=(quiet_end IS NULL))
);
CREATE TABLE notification_channels (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), channel text NOT NULL CHECK(channel IN ('push','email','sms')),
 address_cipher jsonb NOT NULL, address_hash text NOT NULL, masked_address text NOT NULL, verified_at timestamptz,
 verification_hash text, verification_expires_at timestamptz, verification_attempts integer NOT NULL DEFAULT 0, verification_sent_at timestamptz NOT NULL DEFAULT now(),
 disabled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,channel,address_hash)
);
CREATE TABLE notification_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE, channel_id uuid NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','accepted','provider_delivered','failed','unknown','unconfigured','simulated','cancelled')),
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, provider_id text, last_error text, updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(notification_id,channel_id)
);
CREATE OR REPLACE FUNCTION notify_task_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.assignee_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.assignee_id IS DISTINCT FROM OLD.assignee_id OR NEW.due_at IS DISTINCT FROM OLD.due_at) THEN
  INSERT INTO notifications(farm_id,user_id,kind,message_key,arguments,entity_type,entity_id,dedupe_key)
  VALUES(NEW.farm_id,NEW.assignee_id,'task','task_assigned',jsonb_build_object('title',NEW.title,'dueAt',NEW.due_at),'task',NEW.id,'task:'||NEW.id||':'||NEW.version) ON CONFLICT DO NOTHING;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER task_assignment_notification AFTER INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION notify_task_assignment();
CREATE OR REPLACE FUNCTION notify_incident() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO notifications(farm_id,user_id,kind,message_key,arguments,entity_type,entity_id,dedupe_key)
 SELECT NEW.farm_id,m.user_id,'incident','incident_attention',jsonb_build_object('title',NEW.title,'severity',NEW.severity),'incident',NEW.id,'incident:'||NEW.id||':'||NEW.version
 FROM memberships m WHERE m.farm_id=NEW.farm_id AND (m.role IN ('owner','manager') OR m.user_id=NEW.assignee_id) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER incident_notification AFTER INSERT OR UPDATE ON incidents FOR EACH ROW EXECUTE FUNCTION notify_incident();
CREATE TABLE camera_configurations (
 asset_id uuid PRIMARY KEY, farm_id uuid NOT NULL, provider text NOT NULL CHECK(provider IN ('simulator','gateway')),
 retention_days integer NOT NULL DEFAULT 7 CHECK(retention_days BETWEEN 1 AND 90), events_enabled boolean NOT NULL DEFAULT true, live_enabled boolean NOT NULL DEFAULT false,
 capabilities jsonb NOT NULL DEFAULT '{"live":true,"snapshot":true,"motion":true,"person":false,"ptz":false}',
 zones jsonb NOT NULL DEFAULT '[]', schedules jsonb NOT NULL DEFAULT '[]', dedupe_seconds integer NOT NULL DEFAULT 30 CHECK(dedupe_seconds BETWEEN 1 AND 600),
 last_frame_at timestamptz, version integer NOT NULL DEFAULT 1, FOREIGN KEY(farm_id,asset_id) REFERENCES assets(farm_id,id)
);
CREATE TABLE camera_access (asset_id uuid NOT NULL REFERENCES camera_configurations(asset_id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id), granted_by uuid NOT NULL REFERENCES users(id), PRIMARY KEY(asset_id,user_id));
ALTER TABLE camera_events DROP CONSTRAINT camera_events_source_check;
ALTER TABLE camera_events ADD CONSTRAINT camera_events_source_check CHECK(source IN ('simulator','gateway'));
ALTER TABLE camera_events ADD COLUMN zone_id text;
ALTER TABLE camera_events ADD COLUMN incident_id uuid;
ALTER TABLE camera_events ADD CONSTRAINT camera_incident_farm_fk FOREIGN KEY(farm_id,incident_id) REFERENCES incidents(farm_id,id);
ALTER TABLE camera_events ADD COLUMN confidence numeric CHECK(confidence BETWEEN 0 AND 1);
CREATE TABLE camera_segments (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL, asset_id uuid NOT NULL, sequence bigint NOT NULL, observed_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 duration numeric NOT NULL CHECK(duration>0 AND duration<=15), discontinuity boolean NOT NULL DEFAULT false, size_bytes integer NOT NULL CHECK(size_bytes>0 AND size_bytes<=5242880),
 content_hash text NOT NULL, object_key text NOT NULL UNIQUE, source text NOT NULL CHECK(source IN ('simulator','gateway')), expires_at timestamptz NOT NULL,
 UNIQUE(asset_id,sequence), FOREIGN KEY(farm_id,asset_id) REFERENCES assets(farm_id,id)
);
CREATE TABLE camera_event_segments (event_id uuid NOT NULL REFERENCES camera_events(id) ON DELETE CASCADE, segment_id uuid NOT NULL REFERENCES camera_segments(id) ON DELETE CASCADE, PRIMARY KEY(event_id,segment_id));
CREATE TABLE camera_snapshots (asset_id uuid PRIMARY KEY, farm_id uuid NOT NULL, observed_at timestamptz NOT NULL, content_hash text NOT NULL, object_key text NOT NULL UNIQUE, size_bytes integer NOT NULL, source text NOT NULL, FOREIGN KEY(farm_id,asset_id) REFERENCES assets(farm_id,id));
CREATE TABLE camera_sessions (id uuid PRIMARY KEY, farm_id uuid NOT NULL, asset_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES users(id), event_id uuid REFERENCES camera_events(id) ON DELETE CASCADE, token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(farm_id,asset_id) REFERENCES assets(farm_id,id));
CREATE TABLE object_garbage (object_key text PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), reason text NOT NULL, size_bytes bigint NOT NULL DEFAULT 0 CHECK(size_bytes>=0), media_kind text NOT NULL DEFAULT 'unknown' CHECK(media_kind IN ('field','camera','unknown')), eligible_at timestamptz NOT NULL DEFAULT now()+interval '1 hour', attempts integer NOT NULL DEFAULT 0, deleted_at timestamptz);
CREATE TABLE media_retirement (id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), actor_id uuid REFERENCES users(id), content_hash text NOT NULL, object_key text NOT NULL, reason text NOT NULL, retired_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE backup_runs (id uuid PRIMARY KEY, started_at timestamptz NOT NULL, completed_at timestamptz, status text NOT NULL, archive_hash text, destination text, verified boolean NOT NULL DEFAULT false, error_code text);

ALTER TABLE telemetry DROP CONSTRAINT IF EXISTS telemetry_source_check;
ALTER TABLE telemetry ADD CONSTRAINT telemetry_source_check CHECK(source IN ('simulator','gateway'));
ALTER TABLE equipment_commands ADD COLUMN configuration_hash text;
ALTER TABLE notifications ADD COLUMN available_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE storage_scan_cursors(farm_id uuid PRIMARY KEY REFERENCES farms(id),cursor text,next_scan_at timestamptz NOT NULL DEFAULT now());

ALTER TABLE camera_configurations ADD COLUMN snapshot_requested_at timestamptz;
