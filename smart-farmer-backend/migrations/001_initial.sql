CREATE TABLE users (
 id uuid PRIMARY KEY, username text NOT NULL UNIQUE, password_hash text NOT NULL,
 language text NOT NULL CHECK (language IN ('sn','nd')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE farms (
 id uuid PRIMARY KEY, name text NOT NULL, timezone text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memberships (
 user_id uuid NOT NULL REFERENCES users(id), farm_id uuid NOT NULL REFERENCES farms(id),
 role text NOT NULL CHECK (role IN ('owner','manager','worker','adviser')),
 PRIMARY KEY (user_id, farm_id)
);
CREATE TABLE sessions (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE TABLE projects (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), name text NOT NULL,
 crop text NOT NULL, irrigation boolean NOT NULL DEFAULT false,
 planting_date date, variety text, objective text, area_ha numeric CHECK (area_ha > 0), stage text,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (farm_id, id)
);
CREATE TABLE activities (
 id uuid NOT NULL, farm_id uuid NOT NULL REFERENCES farms(id), project_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), kind text NOT NULL,
 observed_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
 note text NOT NULL DEFAULT '', quantity numeric CHECK (quantity >= 0), unit text,
 payload_hash text NOT NULL,
 PRIMARY KEY (farm_id, id), FOREIGN KEY (farm_id, project_id) REFERENCES projects(farm_id, id),
 CHECK ((quantity IS NULL AND unit IS NULL) OR (quantity IS NOT NULL AND unit IS NOT NULL))
);
CREATE INDEX activities_project_time ON activities(farm_id, project_id, observed_at DESC);
