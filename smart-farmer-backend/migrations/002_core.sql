-- Additive workflow migration. No seed data or assumed farm balances.
ALTER TABLE sessions ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX sessions_id ON sessions(id);
ALTER TABLE sessions ADD COLUMN label text NOT NULL DEFAULT 'Device';

CREATE TABLE invitations (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
 token_hash text NOT NULL UNIQUE, role text NOT NULL CHECK(role IN ('manager','worker','adviser')),
 created_by uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL,
 accepted_by uuid REFERENCES users(id), accepted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE recovery_codes (
 user_id uuid PRIMARY KEY REFERENCES users(id), token_hash text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(), used_at timestamptz
);
CREATE TABLE audit_events (
 id uuid PRIMARY KEY, farm_id uuid REFERENCES farms(id), actor_id uuid NOT NULL REFERENCES users(id),
 entity_type text NOT NULL, entity_id uuid NOT NULL, action text NOT NULL,
 reason text NOT NULL, previous jsonb, current jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_farm_time ON audit_events(farm_id,created_at DESC);

ALTER TABLE projects ALTER COLUMN crop DROP NOT NULL;
ALTER TABLE projects ADD COLUMN enterprise_type text NOT NULL DEFAULT 'crop'
 CHECK(enterprise_type IN ('crop','broiler','layer','breeder','hatchery','rabbit_breeding','rabbit_growout','fish','fish_nursery'));
ALTER TABLE projects ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed'));
ALTER TABLE projects ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version > 0);
ALTER TABLE projects ADD COLUMN as_of_date date;
ALTER TABLE projects ADD COLUMN opening_count numeric(18,6) CHECK(opening_count >= 0);
ALTER TABLE projects ADD COLUMN current_count numeric(18,6) CHECK(current_count >= 0);
ALTER TABLE projects ADD COLUMN count_basis text NOT NULL DEFAULT 'unknown' CHECK(count_basis IN ('unknown','verified','estimated'));
ALTER TABLE projects ADD COLUMN details jsonb NOT NULL DEFAULT '{}';
ALTER TABLE projects ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE projects ADD COLUMN created_by uuid REFERENCES users(id);
ALTER TABLE projects ADD COLUMN payload_hash text;
ALTER TABLE projects ADD CONSTRAINT project_crop_kind CHECK(enterprise_type <> 'crop' OR crop IS NOT NULL);

CREATE TABLE tasks (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), project_id uuid,
 title text NOT NULL, instructions text NOT NULL DEFAULT '', assignee_id uuid,
 due_at timestamptz, status text NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','started','completed','blocked','cancelled')),
 evidence text NOT NULL DEFAULT '', reason text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1,
 created_by uuid NOT NULL REFERENCES users(id), payload_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(farm_id,id), FOREIGN KEY(farm_id,project_id) REFERENCES projects(farm_id,id),
 FOREIGN KEY(assignee_id,farm_id) REFERENCES memberships(user_id,farm_id)
);
CREATE INDEX tasks_due ON tasks(farm_id,status,due_at);

CREATE TABLE stock_items (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), project_id uuid,
 name text NOT NULL, unit text NOT NULL CHECK(unit IN ('kg','g','l','ml','count','egg','bird','rabbit','fish')),
 quantity numeric(18,6) NOT NULL CHECK(quantity >= 0),
 reserved_quantity numeric(18,6) NOT NULL DEFAULT 0 CHECK(reserved_quantity >= 0 AND reserved_quantity <= quantity),
 unit_cost numeric(18,6) CHECK(unit_cost >= 0), currency text CHECK(currency ~ '^[A-Z]{3}$'),
 version integer NOT NULL DEFAULT 1, created_by uuid NOT NULL REFERENCES users(id), payload_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((unit_cost IS NULL) = (currency IS NULL)),
 CHECK(unit IN ('kg','g','l','ml') OR (quantity=trunc(quantity) AND reserved_quantity=trunc(reserved_quantity))),
 UNIQUE(farm_id,id), FOREIGN KEY(farm_id,project_id) REFERENCES projects(farm_id,id)
);
CREATE TABLE stock_movements (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), stock_item_id uuid NOT NULL,
 project_id uuid, actor_id uuid NOT NULL REFERENCES users(id), kind text NOT NULL,
 quantity numeric(18,6) NOT NULL, unit text NOT NULL, source_type text NOT NULL, source_id uuid NOT NULL,
 observed_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(), note text NOT NULL DEFAULT '',
 FOREIGN KEY(farm_id,stock_item_id) REFERENCES stock_items(farm_id,id),
 FOREIGN KEY(farm_id,project_id) REFERENCES projects(farm_id,id)
);
CREATE INDEX stock_movement_source ON stock_movements(farm_id,source_type,source_id);
CREATE TABLE stock_record_requests (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), stock_item_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id), payload_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(farm_id,stock_item_id) REFERENCES stock_items(farm_id,id)
);
CREATE TABLE financial_entries (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), project_id uuid,
 actor_id uuid NOT NULL REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN ('expense','input_consumption','revenue','payment')),
 amount numeric(18,2) NOT NULL CHECK(amount >= 0), currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 source_type text NOT NULL, source_id uuid NOT NULL, observed_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(), note text NOT NULL DEFAULT '',
 UNIQUE(farm_id,source_type,source_id,kind), FOREIGN KEY(farm_id,project_id) REFERENCES projects(farm_id,id)
);
CREATE TABLE manual_payment_records (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), revenue_id uuid NOT NULL REFERENCES financial_entries(id),
 created_by uuid NOT NULL REFERENCES users(id), amount numeric(18,2) NOT NULL CHECK(amount>0),
 currency text NOT NULL, payload_hash text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE activities ADD COLUMN stock_item_id uuid;
ALTER TABLE activities ADD COLUMN task_id uuid;
ALTER TABLE activities ADD COLUMN amount numeric(18,2) CHECK(amount >= 0);
ALTER TABLE activities ADD COLUMN currency text CHECK(currency ~ '^[A-Z]{3}$');
ALTER TABLE activities ADD CONSTRAINT activity_stock_fk FOREIGN KEY(farm_id,stock_item_id) REFERENCES stock_items(farm_id,id);
ALTER TABLE activities ADD CONSTRAINT activity_task_fk FOREIGN KEY(farm_id,task_id) REFERENCES tasks(farm_id,id);
ALTER TABLE activities ADD CONSTRAINT activity_money_pair CHECK((amount IS NULL) = (currency IS NULL));

CREATE TABLE animal_events (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), project_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), type text NOT NULL,
 observed_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
 count numeric(18,6), destination_project_id uuid, stock_item_id uuid,
 quantity numeric(18,6), unit text, note text NOT NULL DEFAULT '', metadata jsonb NOT NULL DEFAULT '{}',
 payload_hash text NOT NULL,
 FOREIGN KEY(farm_id,project_id) REFERENCES projects(farm_id,id),
 FOREIGN KEY(farm_id,destination_project_id) REFERENCES projects(farm_id,id),
 FOREIGN KEY(farm_id,stock_item_id) REFERENCES stock_items(farm_id,id)
);
CREATE INDEX animal_history ON animal_events(farm_id,project_id,observed_at);
CREATE TABLE treatment_restrictions (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), project_id uuid NOT NULL,
 source_project_id uuid, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK(ends_at > starts_at),
 scope text NOT NULL CHECK(scope IN ('all','harvest','sale','transfer')),
 reason text NOT NULL, authorized_by text NOT NULL, created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), origin_restriction_id uuid REFERENCES treatment_restrictions(id),
 FOREIGN KEY(farm_id,project_id) REFERENCES projects(farm_id,id),
 FOREIGN KEY(farm_id,source_project_id) REFERENCES projects(farm_id,id)
);
CREATE INDEX restrictions_active ON treatment_restrictions(farm_id,project_id,ends_at);
CREATE TABLE animal_identities (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), project_id uuid NOT NULL,
 identifier text NOT NULL, sex text CHECK(sex IN ('female','male','unknown')), birth_date date,
 dam_id uuid, sire_id uuid, status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','dead','sold','harvested')),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(farm_id,id), UNIQUE(farm_id,identifier),
 FOREIGN KEY(farm_id,project_id) REFERENCES projects(farm_id,id),
 FOREIGN KEY(farm_id,dam_id) REFERENCES animal_identities(farm_id,id),
 FOREIGN KEY(farm_id,sire_id) REFERENCES animal_identities(farm_id,id)
);
CREATE TABLE project_cost_transfers (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), event_id uuid NOT NULL REFERENCES animal_events(id),
 source_project_id uuid NOT NULL, destination_project_id uuid NOT NULL,
 amount numeric(18,2) NOT NULL CHECK(amount >= 0), currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 basis text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(event_id,currency),
 FOREIGN KEY(farm_id,source_project_id) REFERENCES projects(farm_id,id),
 FOREIGN KEY(farm_id,destination_project_id) REFERENCES projects(farm_id,id)
);
CREATE TABLE incidents (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), project_id uuid,
 title text NOT NULL, description text NOT NULL DEFAULT '',
 severity text NOT NULL CHECK(severity IN ('low','medium','high','urgent')),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','acknowledged','resolved')),
 assignee_id uuid, note text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1,
 created_by uuid NOT NULL REFERENCES users(id), payload_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(farm_id,id), FOREIGN KEY(farm_id,project_id) REFERENCES projects(farm_id,id),
 FOREIGN KEY(assignee_id,farm_id) REFERENCES memberships(user_id,farm_id)
);
