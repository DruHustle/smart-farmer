-- Private herd telemetry and marketplace discovery. Additive; no hardware is assumed online.
CREATE TABLE livestock_trackers (
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  project_id uuid NOT NULL, animal_id uuid,
  label text NOT NULL CHECK(length(label) BETWEEN 1 AND 120),
  provider text NOT NULL CHECK(provider IN ('gnss_lorawan','gnss_cellular','gnss_satellite','demo','manual_reference')),
  external_id text NOT NULL CHECK(length(external_id) BETWEEN 1 AND 120),
  credential_hash text,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','revoked')),
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(farm_id,id), UNIQUE(farm_id,provider,external_id),
  FOREIGN KEY(farm_id,project_id) REFERENCES projects(farm_id,id),
  FOREIGN KEY(farm_id,animal_id) REFERENCES animal_identities(farm_id,id),
  CHECK ((provider='manual_reference' AND credential_hash IS NULL) OR
         (provider<>'manual_reference' AND ((status='revoked' AND credential_hash IS NULL) OR credential_hash ~ '^[a-f0-9]{64})
);
CREATE INDEX livestock_trackers_project ON livestock_trackers(farm_id,project_id);
CREATE TABLE livestock_tracker_readings (
  id uuid PRIMARY KEY, farm_id uuid NOT NULL, tracker_id uuid NOT NULL,
  observed_at timestamptz NOT NULL, latitude double precision NOT NULL CHECK(latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK(longitude BETWEEN -180 AND 180),
  accuracy_m double precision CHECK(accuracy_m BETWEEN 0 AND 5000),
  battery_percent smallint CHECK(battery_percent BETWEEN 0 AND 100),
  quality text NOT NULL CHECK(quality IN ('gnss','estimated','simulated')),
  payload_hash text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(farm_id,tracker_id) REFERENCES livestock_trackers(farm_id,id)
);
CREATE INDEX livestock_tracker_history ON livestock_tracker_readings(tracker_id,observed_at DESC,id DESC);
CREATE TABLE livestock_geofences (
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  project_id uuid, latitude double precision NOT NULL CHECK(latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK(longitude BETWEEN -180 AND 180),
  radius_m integer NOT NULL CHECK(radius_m BETWEEN 30 AND 50000),
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(farm_id,id), FOREIGN KEY(farm_id,project_id) REFERENCES projects(farm_id,id)
);
CREATE TABLE livestock_tracker_alerts (
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  tracker_id uuid NOT NULL, geofence_id uuid,
  reading_id uuid NOT NULL REFERENCES livestock_tracker_readings(id),
  kind text NOT NULL CHECK(kind IN ('outside_geofence','low_battery')),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','acknowledged','resolved')),
  opened_at timestamptz NOT NULL DEFAULT now(), acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users(id), resolved_at timestamptz,
  FOREIGN KEY(farm_id,tracker_id) REFERENCES livestock_trackers(farm_id,id),
  FOREIGN KEY(farm_id,geofence_id) REFERENCES livestock_geofences(farm_id,id)
);
CREATE UNIQUE INDEX livestock_active_fence_alert ON livestock_tracker_alerts(tracker_id,geofence_id,kind)
  WHERE status IN ('open','acknowledged') AND geofence_id IS NOT NULL;
CREATE UNIQUE INDEX livestock_active_battery_alert ON livestock_tracker_alerts(tracker_id,kind)
  WHERE status IN ('open','acknowledged') AND geofence_id IS NULL;
CREATE INDEX livestock_alerts_by_farm ON livestock_tracker_alerts(farm_id,opened_at DESC);

-- A seller is a public farm account; private farm coordinates are never exposed.
CREATE TABLE market_favorites (
  user_id uuid NOT NULL REFERENCES users(id), listing_id uuid NOT NULL REFERENCES market_listings(id),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,listing_id)
);
CREATE TABLE market_saved_searches (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  query text NOT NULL DEFAULT '' CHECK(length(query)<=100),
  category text CHECK(category IN ('produce','input','animal','equipment','other')),
  area text NOT NULL DEFAULT '' CHECK(length(area)<=150),
  currency text CHECK(currency ~ '^[A-Z]{3}$'),
  min_price numeric(18,2) CHECK(min_price>=0),
  max_price numeric(18,2) CHECK(max_price>=0),
  condition_query text NOT NULL DEFAULT '' CHECK(length(condition_query)<=100),
  notify boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(min_price IS NULL OR max_price IS NULL OR min_price<=max_price)
);
CREATE INDEX market_saved_searches_owner ON market_saved_searches(user_id,created_at DESC);
CREATE TABLE market_followed_sellers (
  user_id uuid NOT NULL REFERENCES users(id), farm_id uuid NOT NULL REFERENCES farms(id),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,farm_id)
);
CREATE TABLE market_discovery_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  listing_id uuid NOT NULL REFERENCES market_listings(id),
  kind text NOT NULL CHECK(kind IN ('saved_search','followed_seller')),
  created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz,
  UNIQUE(user_id,listing_id,kind)
);
CREATE INDEX market_alerts_owner ON market_discovery_alerts(user_id,created_at DESC);

CREATE FUNCTION create_market_discovery_alerts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'active' THEN RETURN NEW; END IF;
  INSERT INTO market_discovery_alerts(user_id,listing_id,kind)
  SELECT DISTINCT s.user_id,NEW.id,'saved_search' FROM market_saved_searches s
  WHERE s.notify
    AND (s.query='' OR NEW.title ILIKE '%'||s.query||'%')
    AND (s.category IS NULL OR s.category=NEW.category)
    AND (s.area='' OR NEW.collection_area ILIKE '%'||s.area||'%')
    AND (s.currency IS NULL OR s.currency=NEW.currency)
    AND (s.min_price IS NULL OR NEW.price>=s.min_price)
    AND (s.max_price IS NULL OR NEW.price<=s.max_price)
    AND (s.condition_query='' OR NEW.condition ILIKE '%'||s.condition_query||'%')
    AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.farm_id=NEW.farm_id AND m.user_id=s.user_id)
  ON CONFLICT DO NOTHING;
  INSERT INTO market_discovery_alerts(user_id,listing_id,kind)
  SELECT f.user_id,NEW.id,'followed_seller' FROM market_followed_sellers f
  WHERE f.farm_id=NEW.farm_id
    AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.farm_id=NEW.farm_id AND m.user_id=f.user_id)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER market_discovery_on_listing AFTER INSERT ON market_listings
FOR EACH ROW EXECUTE FUNCTION create_market_discovery_alerts();
)))
);
CREATE INDEX livestock_trackers_project ON livestock_trackers(farm_id,project_id);
CREATE TABLE livestock_tracker_readings (
  id uuid PRIMARY KEY, farm_id uuid NOT NULL, tracker_id uuid NOT NULL,
  observed_at timestamptz NOT NULL, latitude double precision NOT NULL CHECK(latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK(longitude BETWEEN -180 AND 180),
  accuracy_m double precision CHECK(accuracy_m BETWEEN 0 AND 5000),
  battery_percent smallint CHECK(battery_percent BETWEEN 0 AND 100),
  quality text NOT NULL CHECK(quality IN ('gnss','estimated','simulated')),
  payload_hash text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(farm_id,tracker_id) REFERENCES livestock_trackers(farm_id,id)
);
CREATE INDEX livestock_tracker_history ON livestock_tracker_readings(tracker_id,observed_at DESC,id DESC);
CREATE TABLE livestock_geofences (
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  project_id uuid, latitude double precision NOT NULL CHECK(latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK(longitude BETWEEN -180 AND 180),
  radius_m integer NOT NULL CHECK(radius_m BETWEEN 30 AND 50000),
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(farm_id,id), FOREIGN KEY(farm_id,project_id) REFERENCES projects(farm_id,id)
);
CREATE TABLE livestock_tracker_alerts (
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  tracker_id uuid NOT NULL, geofence_id uuid,
  reading_id uuid NOT NULL REFERENCES livestock_tracker_readings(id),
  kind text NOT NULL CHECK(kind IN ('outside_geofence','low_battery')),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','acknowledged','resolved')),
  opened_at timestamptz NOT NULL DEFAULT now(), acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users(id), resolved_at timestamptz,
  FOREIGN KEY(farm_id,tracker_id) REFERENCES livestock_trackers(farm_id,id),
  FOREIGN KEY(farm_id,geofence_id) REFERENCES livestock_geofences(farm_id,id)
);
CREATE UNIQUE INDEX livestock_active_fence_alert ON livestock_tracker_alerts(tracker_id,geofence_id,kind)
  WHERE status IN ('open','acknowledged') AND geofence_id IS NOT NULL;
CREATE UNIQUE INDEX livestock_active_battery_alert ON livestock_tracker_alerts(tracker_id,kind)
  WHERE status IN ('open','acknowledged') AND geofence_id IS NULL;
CREATE INDEX livestock_alerts_by_farm ON livestock_tracker_alerts(farm_id,opened_at DESC);

-- A seller is a public farm account; private farm coordinates are never exposed.
CREATE TABLE market_favorites (
  user_id uuid NOT NULL REFERENCES users(id), listing_id uuid NOT NULL REFERENCES market_listings(id),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,listing_id)
);
CREATE TABLE market_saved_searches (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  query text NOT NULL DEFAULT '' CHECK(length(query)<=100),
  category text CHECK(category IN ('produce','input','animal','equipment','other')),
  area text NOT NULL DEFAULT '' CHECK(length(area)<=150),
  currency text CHECK(currency ~ '^[A-Z]{3}$'),
  min_price numeric(18,2) CHECK(min_price>=0),
  max_price numeric(18,2) CHECK(max_price>=0),
  condition_query text NOT NULL DEFAULT '' CHECK(length(condition_query)<=100),
  notify boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(min_price IS NULL OR max_price IS NULL OR min_price<=max_price)
);
CREATE INDEX market_saved_searches_owner ON market_saved_searches(user_id,created_at DESC);
CREATE TABLE market_followed_sellers (
  user_id uuid NOT NULL REFERENCES users(id), farm_id uuid NOT NULL REFERENCES farms(id),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,farm_id)
);
CREATE TABLE market_discovery_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  listing_id uuid NOT NULL REFERENCES market_listings(id),
  kind text NOT NULL CHECK(kind IN ('saved_search','followed_seller')),
  created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz,
  UNIQUE(user_id,listing_id,kind)
);
CREATE INDEX market_alerts_owner ON market_discovery_alerts(user_id,created_at DESC);

CREATE FUNCTION create_market_discovery_alerts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'active' THEN RETURN NEW; END IF;
  INSERT INTO market_discovery_alerts(user_id,listing_id,kind)
  SELECT DISTINCT s.user_id,NEW.id,'saved_search' FROM market_saved_searches s
  WHERE s.notify
    AND (s.query='' OR NEW.title ILIKE '%'||s.query||'%')
    AND (s.category IS NULL OR s.category=NEW.category)
    AND (s.area='' OR NEW.collection_area ILIKE '%'||s.area||'%')
    AND (s.currency IS NULL OR s.currency=NEW.currency)
    AND (s.min_price IS NULL OR NEW.price>=s.min_price)
    AND (s.max_price IS NULL OR NEW.price<=s.max_price)
    AND (s.condition_query='' OR NEW.condition ILIKE '%'||s.condition_query||'%')
    AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.farm_id=NEW.farm_id AND m.user_id=s.user_id)
  ON CONFLICT DO NOTHING;
  INSERT INTO market_discovery_alerts(user_id,listing_id,kind)
  SELECT f.user_id,NEW.id,'followed_seller' FROM market_followed_sellers f
  WHERE f.farm_id=NEW.farm_id
    AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.farm_id=NEW.farm_id AND m.user_id=f.user_id)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER market_discovery_on_listing AFTER INSERT ON market_listings
FOR EACH ROW EXECUTE FUNCTION create_market_discovery_alerts();
