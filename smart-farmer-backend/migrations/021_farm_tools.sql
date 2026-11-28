-- Sourced farm tools. No provider records, contacts or agronomy are seeded.
ALTER TABLE reference_material DROP CONSTRAINT reference_material_language_check;
ALTER TABLE reference_material ADD CONSTRAINT reference_material_language_check CHECK(language IN ('en','sn','nd'));

CREATE TABLE farm_market_prices (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), created_by uuid NOT NULL REFERENCES users(id),
 commodity text NOT NULL, market text NOT NULL, price numeric(20,6) NOT NULL CHECK(price>0),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), unit text NOT NULL, observed_at timestamptz NOT NULL,
 source text NOT NULL, source_url text, note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), payload_hash text NOT NULL
);
CREATE INDEX farm_market_prices_lookup ON farm_market_prices(farm_id,commodity,market,observed_at DESC,id);

CREATE TABLE farm_support_centres (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), created_by uuid NOT NULL REFERENCES users(id),
 name text NOT NULL, kind text NOT NULL CHECK(kind IN ('extension_officer','support_centre')), area text NOT NULL,
 latitude double precision CHECK(latitude BETWEEN -90 AND 90), longitude double precision CHECK(longitude BETWEEN -180 AND 180),
 phone text, email text, source_url text NOT NULL, verified_on date NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), payload_hash text NOT NULL, UNIQUE(farm_id,id), CHECK((latitude IS NULL)=(longitude IS NULL))
);
CREATE INDEX farm_support_centres_farm ON farm_support_centres(farm_id,id);
CREATE TABLE farm_training_guides (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), created_by uuid NOT NULL REFERENCES users(id),
 title text NOT NULL, summary text NOT NULL, content text NOT NULL, language text NOT NULL CHECK(language IN ('en','sn','nd')),
 source_url text NOT NULL, reviewed_by text NOT NULL, reviewed_on date NOT NULL, video_url text, video_size_kb integer CHECK(video_size_kb>0),
 created_at timestamptz NOT NULL DEFAULT now(), payload_hash text NOT NULL, CHECK(video_size_kb IS NULL OR video_url IS NOT NULL)
);
CREATE INDEX farm_training_guides_farm ON farm_training_guides(farm_id,id);
CREATE TABLE farm_support_visits (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), created_by uuid NOT NULL REFERENCES users(id), centre_id uuid NOT NULL,
 requested_for timestamptz NOT NULL, reason text NOT NULL, status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','confirmed','completed','cancelled')),
 note text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), payload_hash text NOT NULL,
 FOREIGN KEY(farm_id,centre_id) REFERENCES farm_support_centres(farm_id,id)
);
CREATE INDEX farm_support_visits_farm ON farm_support_visits(farm_id,id);

CREATE TABLE farm_trials (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), created_by uuid NOT NULL REFERENCES users(id), project_id uuid NOT NULL,
 name text NOT NULL, control_label text NOT NULL, treatment_label text NOT NULL, practice text NOT NULL, metric text NOT NULL, unit text NOT NULL,
 started_on date NOT NULL, note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), payload_hash text NOT NULL,
 UNIQUE(farm_id,id), FOREIGN KEY(farm_id,project_id) REFERENCES projects(farm_id,id)
);
CREATE INDEX farm_trials_farm ON farm_trials(farm_id,id);
CREATE TABLE farm_trial_observations (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), created_by uuid NOT NULL REFERENCES users(id), trial_id uuid NOT NULL,
 arm text NOT NULL CHECK(arm IN ('control','treatment')), value double precision NOT NULL CHECK(value BETWEEN -1e12 AND 1e12),
 observed_at timestamptz NOT NULL, source text NOT NULL, note text NOT NULL DEFAULT '', media_ids uuid[] NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), payload_hash text NOT NULL,
 FOREIGN KEY(farm_id,trial_id) REFERENCES farm_trials(farm_id,id)
);
CREATE INDEX farm_trial_observations_history ON farm_trial_observations(farm_id,trial_id,observed_at DESC,id);

CREATE TABLE farm_growing_systems (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), created_by uuid NOT NULL REFERENCES users(id),
 name text NOT NULL, type text NOT NULL CHECK(type IN ('hydroponics','aquaponics')), crop_project_id uuid NOT NULL, fish_project_id uuid, location_id uuid,
 volume_litres numeric(18,3) CHECK(volume_litres>0), notes text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), payload_hash text NOT NULL,
 UNIQUE(farm_id,id), CHECK(type<>'aquaponics' OR fish_project_id IS NOT NULL),
 FOREIGN KEY(farm_id,crop_project_id) REFERENCES projects(farm_id,id), FOREIGN KEY(farm_id,fish_project_id) REFERENCES projects(farm_id,id),
 FOREIGN KEY(farm_id,location_id) REFERENCES farm_locations(farm_id,id)
);
CREATE INDEX farm_growing_systems_farm ON farm_growing_systems(farm_id,id);
CREATE TABLE farm_water_logs (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), created_by uuid NOT NULL REFERENCES users(id), system_id uuid NOT NULL,
 observed_at timestamptz NOT NULL, source text NOT NULL, ph numeric CHECK(ph BETWEEN 0 AND 14), ec_ms_cm numeric CHECK(ec_ms_cm BETWEEN 0 AND 200),
 temperature_c numeric CHECK(temperature_c BETWEEN -10 AND 100), dissolved_oxygen_mg_l numeric CHECK(dissolved_oxygen_mg_l BETWEEN 0 AND 100),
 ammonia_mg_l numeric CHECK(ammonia_mg_l BETWEEN 0 AND 10000), nitrite_mg_l numeric CHECK(nitrite_mg_l BETWEEN 0 AND 10000), nitrate_mg_l numeric CHECK(nitrate_mg_l BETWEEN 0 AND 10000),
 note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), payload_hash text NOT NULL,
 CHECK(num_nonnulls(ph,ec_ms_cm,temperature_c,dissolved_oxygen_mg_l,ammonia_mg_l,nitrite_mg_l,nitrate_mg_l)>0),
 FOREIGN KEY(farm_id,system_id) REFERENCES farm_growing_systems(farm_id,id)
);
CREATE INDEX farm_water_logs_history ON farm_water_logs(farm_id,system_id,observed_at DESC,id);

CREATE TABLE farm_phone_links (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), user_id uuid NOT NULL REFERENCES users(id), channel_id uuid NOT NULL REFERENCES notification_channels(id),
 project_id uuid NOT NULL, code_hash text NOT NULL UNIQUE, code_cipher jsonb NOT NULL, session_cipher jsonb NOT NULL,
 session_hash text NOT NULL, expires_at timestamptz NOT NULL, access_expires_at timestamptz NOT NULL,
 linked_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), payload_hash text NOT NULL,
 FOREIGN KEY(farm_id,project_id) REFERENCES projects(farm_id,id)
);
CREATE INDEX farm_phone_links_channel ON farm_phone_links(channel_id) WHERE revoked_at IS NULL;
CREATE TABLE farm_phone_requests (
 request_id text PRIMARY KEY, link_id uuid REFERENCES farm_phone_links(id), payload_hash text NOT NULL,
 response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
