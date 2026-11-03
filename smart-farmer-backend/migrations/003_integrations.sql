CREATE TABLE assets (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), name text NOT NULL,
 category text NOT NULL CHECK(category IN ('borehole','pump','pivot','valve','tank','sensor','power','camera','other')),
 model text, protocol text NOT NULL CHECK(protocol IN ('unconfigured','simulator','mqtt','http','modbus')),
 integration_state text NOT NULL CHECK(integration_state IN ('unconfigured','simulated')),
 parent_asset_id uuid, capabilities jsonb NOT NULL DEFAULT '{"telemetry":[],"commands":[]}',
 stale_after_seconds integer NOT NULL DEFAULT 120 CHECK(stale_after_seconds BETWEEN 10 AND 3600),
 last_observed_at timestamptz, latest_telemetry jsonb NOT NULL DEFAULT '{}',
 gateway_token_hash text, gateway_expires_at timestamptz,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(farm_id,id), FOREIGN KEY(farm_id,parent_asset_id) REFERENCES assets(farm_id,id)
);
CREATE TABLE telemetry (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL, asset_id uuid NOT NULL, source text NOT NULL,
 observed_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 measurements jsonb NOT NULL, payload_hash text NOT NULL,
 FOREIGN KEY(farm_id,asset_id) REFERENCES assets(farm_id,id)
);
CREATE INDEX telemetry_asset_time ON telemetry(farm_id,asset_id,observed_at DESC);
CREATE TABLE equipment_commands (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL, asset_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES users(id),
 command text NOT NULL CHECK(command IN ('start','stop')),
 status text NOT NULL CHECK(status IN ('authorized','dispatched','acknowledged','confirmed','failed','rejected','expired','outcome_unknown')),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 dispatched_at timestamptz, acknowledged_at timestamptz, completed_at timestamptz,
 payload_hash text NOT NULL, feedback jsonb, reason text,
 FOREIGN KEY(farm_id,asset_id) REFERENCES assets(farm_id,id)
);
CREATE TABLE command_audit (
 id bigserial PRIMARY KEY, command_id uuid NOT NULL REFERENCES equipment_commands(id),
 status text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(), detail text
);
CREATE INDEX commands_asset_status ON equipment_commands(asset_id,status,expires_at);
CREATE TABLE private_media (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL, activity_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), mime_type text NOT NULL, size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 5242880),
 content_hash text NOT NULL, object_key text NOT NULL UNIQUE, filename text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(farm_id,activity_id) REFERENCES activities(farm_id,id)
);
CREATE INDEX private_media_activity ON private_media(farm_id,activity_id);
CREATE TABLE camera_events (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL, asset_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('motion','person')), source text NOT NULL CHECK(source='simulator'),
 observed_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL, acknowledged_by uuid REFERENCES users(id), acknowledged_at timestamptz,
 payload_hash text NOT NULL, FOREIGN KEY(farm_id,asset_id) REFERENCES assets(farm_id,id)
);
CREATE TABLE market_listings (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL, stock_item_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id), title text NOT NULL,
 quantity numeric(18,6) NOT NULL CHECK(quantity>0), remaining_quantity numeric(18,6) NOT NULL CHECK(remaining_quantity>=0),
 price numeric(18,2) NOT NULL CHECK(price>=0), currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 collection_area text NOT NULL, terms text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
 created_at timestamptz NOT NULL DEFAULT now(), payload_hash text NOT NULL,
 FOREIGN KEY(farm_id,stock_item_id) REFERENCES stock_items(farm_id,id)
);
CREATE TABLE market_orders (
 id uuid PRIMARY KEY, listing_id uuid NOT NULL REFERENCES market_listings(id), buyer_id uuid NOT NULL REFERENCES users(id),
 quantity numeric(18,6) NOT NULL CHECK(quantity>0), unit text NOT NULL,
 amount numeric(18,2) NOT NULL CHECK(amount>=0), currency text NOT NULL,
 status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','fulfilled','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), payload_hash text NOT NULL
);
CREATE TABLE commerce_payments (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES market_orders(id), recorded_by uuid NOT NULL REFERENCES users(id),
 amount numeric(18,2) NOT NULL CHECK(amount>0), currency text NOT NULL, note text NOT NULL DEFAULT '',
 provenance text NOT NULL DEFAULT 'manual' CHECK(provenance='manual'), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE service_listings (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), created_by uuid NOT NULL REFERENCES users(id),
 name text NOT NULL, description text NOT NULL, service_area text NOT NULL,
 rate numeric(18,2) NOT NULL CHECK(rate>=0), currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 rate_basis text NOT NULL, operator_included boolean NOT NULL, fuel_included boolean NOT NULL,
 terms text NOT NULL DEFAULT '', resource_asset_id uuid, active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), payload_hash text NOT NULL,
 FOREIGN KEY(farm_id,resource_asset_id) REFERENCES assets(farm_id,id)
);
CREATE INDEX service_listings_resource ON service_listings(farm_id,resource_asset_id);
CREATE TABLE service_bookings (
 id uuid PRIMARY KEY, service_id uuid NOT NULL REFERENCES service_listings(id), farm_id uuid NOT NULL REFERENCES farms(id),
 project_id uuid, requested_by uuid NOT NULL REFERENCES users(id), starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
 note text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','quoted','confirmed','completed','cancelled')),
 amount numeric(18,2) CHECK(amount>=0), currency text, version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), payload_hash text NOT NULL,
 CHECK(ends_at>starts_at), FOREIGN KEY(farm_id,project_id) REFERENCES projects(farm_id,id)
);
CREATE INDEX service_bookings_schedule ON service_bookings(service_id,status,starts_at,ends_at);
CREATE TABLE booking_audit (
 id bigserial PRIMARY KEY, booking_id uuid NOT NULL REFERENCES service_bookings(id), actor_id uuid NOT NULL REFERENCES users(id),
 status text NOT NULL, amount numeric(18,2), currency text, version integer NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE interaction_reviews (
 id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES users(id), booking_id uuid REFERENCES service_bookings(id),
 order_id uuid REFERENCES market_orders(id), rating integer NOT NULL CHECK(rating BETWEEN 1 AND 5), note text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(), CHECK((booking_id IS NULL)<>(order_id IS NULL)),
 UNIQUE(actor_id,booking_id), UNIQUE(actor_id,order_id)
);
