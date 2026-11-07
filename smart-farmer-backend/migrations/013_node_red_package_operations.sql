-- Additive: 011/012 belong to the separate accounting/tracking candidates. Runtime state
-- is independent of telemetry and cannot authorize device control.
CREATE TABLE node_red_package_operations (
  id uuid PRIMARY KEY,
  runtime_id uuid NOT NULL,
  farm_id uuid NOT NULL REFERENCES farms(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  operation jsonb NOT NULL CHECK (jsonb_typeof(operation)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX node_red_package_operations_farm ON node_red_package_operations(farm_id,created_at DESC);
CREATE TABLE node_red_package_runtimes (
  runtime_id uuid PRIMARY KEY,
  operation_id uuid NOT NULL UNIQUE REFERENCES node_red_package_operations(id)
);
