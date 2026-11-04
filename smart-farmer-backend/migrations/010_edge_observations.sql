-- Read-only gateway observations. Never infer physical equipment state from these rows.
CREATE TABLE farm_edge_observations (
  farm_id uuid NOT NULL REFERENCES farms(id),
  gateway_id varchar(80) NOT NULL,
  event_id uuid NOT NULL,
  source_id varchar(80) NOT NULL,
  kind varchar(32) NOT NULL CHECK (kind IN ('measurement','equipment_status')),
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL,
  payload_hash char(64) NOT NULL,
  PRIMARY KEY (farm_id,gateway_id,event_id)
);
CREATE INDEX farm_edge_recent ON farm_edge_observations(farm_id,received_at DESC);
