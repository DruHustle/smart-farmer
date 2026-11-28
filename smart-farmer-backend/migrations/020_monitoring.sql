-- Forecast refresh bookkeeping and read-only observation alerts. These tables
-- never authorize an actuator command or turn unverified telemetry into fact.
CREATE TABLE weather_refresh_state (
  farm_id uuid PRIMARY KEY REFERENCES farms(id),
  provider text NOT NULL,
  location_key text NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_modified text,
  last_error text
);
-- Cache identical MET requests across farms and coordinate changes. Never
-- duplicate a provider request merely because a second farm uses the location.
CREATE TABLE weather_provider_cache (
  request_key char(64) PRIMARY KEY,
  data jsonb NOT NULL,
  fetched_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  last_modified text
);
CREATE INDEX weather_cache_expiry ON weather_provider_cache(next_attempt_at);
CREATE TABLE monitoring_rules (
  id uuid PRIMARY KEY,
  farm_id uuid NOT NULL REFERENCES farms(id),
  created_by uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  source text NOT NULL CHECK(source IN ('weather','asset','edge')),
  asset_id uuid,
  gateway_id varchar(80), source_id varchar(80), edge_asset_id varchar(80),
  metric varchar(80) NOT NULL,
  operator text NOT NULL CHECK(operator IN ('below','above')),
  threshold numeric NOT NULL CHECK(threshold BETWEEN -1000000000 AND 1000000000),
  unit varchar(32) NOT NULL,
  stale_after_seconds integer NOT NULL CHECK(stale_after_seconds BETWEEN 10 AND 86400),
  lookahead_hours integer NOT NULL CHECK(lookahead_hours BETWEEN 1 AND 72),
  cooldown_minutes integer NOT NULL CHECK(cooldown_minutes BETWEEN 1 AND 10080),
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  payload_hash text NOT NULL,
  last_evaluated_at timestamptz,
  last_triggered_at timestamptz,
  last_event_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(farm_id,id),
  FOREIGN KEY(farm_id,asset_id) REFERENCES assets(farm_id,id),
  CHECK((source='weather' AND asset_id IS NULL AND gateway_id IS NULL AND source_id IS NULL AND edge_asset_id IS NULL)
     OR (source='asset' AND asset_id IS NOT NULL AND gateway_id IS NULL AND source_id IS NULL AND edge_asset_id IS NULL)
     OR (source='edge' AND asset_id IS NULL AND gateway_id IS NOT NULL AND source_id IS NOT NULL AND edge_asset_id IS NOT NULL))
);
CREATE INDEX monitoring_rule_due ON monitoring_rules(last_evaluated_at NULLS FIRST) WHERE enabled;
CREATE INDEX monitoring_rule_farm ON monitoring_rules(farm_id,id);
CREATE TABLE monitoring_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  rule_name text NOT NULL,
  source text NOT NULL,
  metric text NOT NULL,
  value numeric NOT NULL,
  unit text NOT NULL,
  observed_at timestamptz NOT NULL,
  evidence jsonb NOT NULL,
  event_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(farm_id,rule_id) REFERENCES monitoring_rules(farm_id,id),
  UNIQUE(rule_id,event_key)
);
CREATE INDEX monitoring_alert_farm ON monitoring_alerts(farm_id,created_at DESC,id);
CREATE INDEX farm_edge_measurement_time ON farm_edge_observations(farm_id,gateway_id,source_id,(payload->'data'->>'assetId'),(payload->'data'->>'metric'),observed_at DESC) WHERE kind='measurement';
