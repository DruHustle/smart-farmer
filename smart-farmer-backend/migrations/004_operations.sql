CREATE TABLE worker_heartbeats (
 name text PRIMARY KEY, last_seen_at timestamptz NOT NULL, details jsonb NOT NULL DEFAULT '{}'
);
