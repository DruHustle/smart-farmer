-- Product completion. Additive, with no invented farm records.
ALTER TABLE projects DROP CONSTRAINT projects_enterprise_type_check;
ALTER TABLE projects ADD CONSTRAINT projects_enterprise_type_check CHECK(enterprise_type IN ('crop','broiler','layer','breeder','hatchery','rabbit_breeding','rabbit_growout','fish','fish_nursery','fish_breeder','fish_hatchery'));
ALTER TABLE projects ADD COLUMN onboarding_mode text NOT NULL DEFAULT 'existing' CHECK(onboarding_mode IN ('new','existing'));
ALTER TABLE projects ADD COLUMN location_id uuid;
ALTER TABLE projects ADD COLUMN reserved_count numeric(18,6) NOT NULL DEFAULT 0 CHECK(reserved_count>=0 AND reserved_count=trunc(reserved_count) AND (current_count IS NOT NULL OR reserved_count=0) AND (current_count IS NULL OR reserved_count<=current_count));
ALTER TABLE stock_items ADD COLUMN grade text NOT NULL DEFAULT '';
ALTER TABLE stock_items ADD COLUMN location_id uuid;
ALTER TABLE stock_items ADD COLUMN pack_size numeric(18,6) CHECK(pack_size>0);
ALTER TABLE stock_items ADD COLUMN pack_unit text;
ALTER TABLE stock_items ADD CONSTRAINT stock_pack_pair CHECK((pack_size IS NULL)=(pack_unit IS NULL));
ALTER TABLE financial_entries DROP CONSTRAINT financial_entries_kind_check;
ALTER TABLE financial_entries ADD CONSTRAINT financial_entries_kind_check CHECK(kind IN ('expense','input_consumption','revenue','payment','cash_out'));
ALTER TABLE financial_entries DROP CONSTRAINT financial_entries_amount_check;
ALTER TABLE financial_entries ADD CONSTRAINT financial_entries_amount_check CHECK(amount>=0 OR source_type IN ('record_correction','manual_service_refund'));
ALTER TABLE financial_entries ADD COLUMN category text NOT NULL DEFAULT 'other';
ALTER TABLE financial_entries ADD COLUMN receipt_activity_id uuid;
ALTER TABLE financial_entries ADD CONSTRAINT finance_receipt_fk FOREIGN KEY(farm_id,receipt_activity_id) REFERENCES activities(farm_id,id);

CREATE TABLE product_requests (
 id uuid PRIMARY KEY, farm_id uuid REFERENCES farms(id), actor_id uuid NOT NULL REFERENCES users(id),
 payload_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE project_records (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), project_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), animal_id uuid,
 type text NOT NULL CHECK(type IN ('assessment','soil_test','readiness','husbandry','crop_stage','housing','pregnancy','hatch_observation','grading','storage','fuel','labour','irrigation_session')),
 observed_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(), note text NOT NULL DEFAULT '', details jsonb NOT NULL,
 FOREIGN KEY(farm_id,project_id) REFERENCES projects(farm_id,id), FOREIGN KEY(farm_id,animal_id) REFERENCES animal_identities(farm_id,id)
);
CREATE INDEX project_records_feed ON project_records(farm_id,project_id,observed_at DESC,id DESC);
CREATE TABLE task_templates (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), created_by uuid NOT NULL REFERENCES users(id),
 name text NOT NULL, enterprise_type text NOT NULL, source text NOT NULL, source_date date NOT NULL,
 language text NOT NULL CHECK(language IN ('sn','nd')), steps jsonb NOT NULL, version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(farm_id,id)
);
CREATE TABLE task_template_versions (
 template_id uuid NOT NULL REFERENCES task_templates(id), version integer NOT NULL, snapshot jsonb NOT NULL,
 reason text NOT NULL, actor_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(template_id,version)
);
CREATE TABLE project_plans (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), project_id uuid NOT NULL, template_id uuid NOT NULL,
 template_version integer NOT NULL, template_snapshot jsonb NOT NULL, anchor_at timestamptz NOT NULL, assignee_id uuid,
 note text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved')),
 version integer NOT NULL DEFAULT 1, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), approved_at timestamptz,
 UNIQUE(farm_id,id), FOREIGN KEY(farm_id,project_id) REFERENCES projects(farm_id,id),
 FOREIGN KEY(farm_id,template_id) REFERENCES task_templates(farm_id,id), FOREIGN KEY(assignee_id,farm_id) REFERENCES memberships(user_id,farm_id)
);
ALTER TABLE tasks ADD COLUMN plan_id uuid REFERENCES project_plans(id);
ALTER TABLE tasks ADD COLUMN plan_step_key text;
ALTER TABLE tasks ADD COLUMN required_evidence text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX tasks_plan_step ON tasks(plan_id,plan_step_key) WHERE plan_id IS NOT NULL;
CREATE TABLE crop_comparisons (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), project_id uuid NOT NULL, objective text NOT NULL,
 candidates jsonb NOT NULL, budget numeric(18,2), currency text, selected_crop text,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(farm_id,project_id) REFERENCES projects(farm_id,id)
);
CREATE TABLE project_budgets (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), project_id uuid NOT NULL, version_name text NOT NULL,
 lines jsonb NOT NULL, reason text NOT NULL, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(farm_id,project_id) REFERENCES projects(farm_id,id)
);
CREATE TABLE opening_financial_balances (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), project_id uuid NOT NULL, as_of_date date NOT NULL,
 kind text NOT NULL CHECK(kind IN ('cost','sales','cash_received')), amount numeric(18,2) NOT NULL CHECK(amount>=0), currency text NOT NULL,
 source text NOT NULL, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(farm_id,project_id) REFERENCES projects(farm_id,id)
);
CREATE TABLE expense_allocations (
 id uuid PRIMARY KEY, request_id uuid NOT NULL, farm_id uuid NOT NULL REFERENCES farms(id), entry_id uuid NOT NULL REFERENCES financial_entries(id),
 project_id uuid NOT NULL, amount numeric(18,2) NOT NULL CHECK(amount>0), basis text NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(farm_id,project_id) REFERENCES projects(farm_id,id), UNIQUE(request_id,project_id)
);
CREATE INDEX expense_allocations_entry ON expense_allocations(entry_id);
CREATE TABLE activity_corrections (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), activity_id uuid NOT NULL, action text NOT NULL CHECK(action IN ('annotate','reverse')),
 reason text NOT NULL, duplicate_of_activity_id uuid, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(farm_id,activity_id) REFERENCES activities(farm_id,id), FOREIGN KEY(farm_id,duplicate_of_activity_id) REFERENCES activities(farm_id,id)
);
CREATE UNIQUE INDEX activity_single_reversal ON activity_corrections(farm_id,activity_id) WHERE action='reverse';

ALTER TABLE market_listings ALTER COLUMN stock_item_id DROP NOT NULL;
ALTER TABLE market_listings ADD COLUMN animal_project_id uuid;
ALTER TABLE market_listings ADD CONSTRAINT market_animal_project_fk FOREIGN KEY(farm_id,animal_project_id) REFERENCES projects(farm_id,id);
ALTER TABLE market_listings ADD CONSTRAINT market_listing_source CHECK((stock_item_id IS NULL)<>(animal_project_id IS NULL));
ALTER TABLE market_listings ADD COLUMN category text NOT NULL DEFAULT 'produce' CHECK(category IN ('produce','input','animal','equipment','other'));
ALTER TABLE market_listings ADD COLUMN grade text NOT NULL DEFAULT '';
ALTER TABLE market_listings ADD COLUMN condition text NOT NULL DEFAULT '';
ALTER TABLE market_listings ADD COLUMN price_basis text NOT NULL DEFAULT 'unit';
ALTER TABLE market_listings ADD COLUMN availability_at timestamptz;
ALTER TABLE market_listings ADD COLUMN expires_at timestamptz;
ALTER TABLE market_listings ADD COLUMN expected_harvest boolean NOT NULL DEFAULT false;
ALTER TABLE market_listings ADD COLUMN photo_media_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE market_listings ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE market_listings ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE market_orders ADD COLUMN expires_at timestamptz NOT NULL DEFAULT (now()+interval '24 hours');
ALTER TABLE market_orders ADD COLUMN identity_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE market_orders ADD COLUMN fulfilment_event_id uuid REFERENCES animal_events(id);
ALTER TABLE market_orders ADD COLUMN cancellation_reason text;
ALTER TABLE market_orders ADD COLUMN offer_id uuid;
CREATE INDEX market_orders_expiry ON market_orders(status,expires_at);
CREATE TABLE animal_market_reservations (
 identity_id uuid PRIMARY KEY REFERENCES animal_identities(id), order_id uuid NOT NULL REFERENCES market_orders(id),
 farm_id uuid NOT NULL REFERENCES farms(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE market_enquiries (
 id uuid PRIMARY KEY, listing_id uuid NOT NULL REFERENCES market_listings(id), buyer_id uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE market_messages (
 id uuid PRIMARY KEY, enquiry_id uuid NOT NULL REFERENCES market_enquiries(id), actor_id uuid NOT NULL REFERENCES users(id),
 message text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE market_offers (
 id uuid PRIMARY KEY, listing_id uuid NOT NULL REFERENCES market_listings(id), buyer_id uuid NOT NULL REFERENCES users(id),
 quantity numeric(18,6) NOT NULL CHECK(quantity>0), amount numeric(18,2) NOT NULL CHECK(amount>=0), currency text NOT NULL,
 message text NOT NULL DEFAULT '', expires_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','withdrawn','expired')),
 version integer NOT NULL DEFAULT 1, order_id uuid REFERENCES market_orders(id), created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE market_orders ADD CONSTRAINT market_order_offer_fk FOREIGN KEY(offer_id) REFERENCES market_offers(id);
CREATE TABLE buying_requests (
 id uuid PRIMARY KEY, buyer_id uuid NOT NULL REFERENCES users(id), title text NOT NULL, category text NOT NULL,
 quantity numeric(18,6) NOT NULL CHECK(quantity>0), unit text NOT NULL, area text NOT NULL, details text NOT NULL,
 expires_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE buying_responses (
 id uuid PRIMARY KEY, request_id uuid NOT NULL REFERENCES buying_requests(id), actor_id uuid NOT NULL REFERENCES users(id),
 message text NOT NULL, listing_id uuid REFERENCES market_listings(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE market_reports (
 id uuid PRIMARY KEY, listing_id uuid REFERENCES market_listings(id), request_id uuid REFERENCES buying_requests(id),
 reporter_id uuid NOT NULL REFERENCES users(id), reason text NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','archived','dismissed')), resolved_by uuid REFERENCES users(id), note text,
 created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz,
 CHECK((listing_id IS NULL)<>(request_id IS NULL))
);

ALTER TABLE service_listings ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE service_listings ADD COLUMN minimum_charge numeric(18,2) NOT NULL DEFAULT 0 CHECK(minimum_charge>=0);
ALTER TABLE service_listings ADD COLUMN mobilisation_charge numeric(18,2) NOT NULL DEFAULT 0 CHECK(mobilisation_charge>=0);
ALTER TABLE service_listings ADD COLUMN cancellation_terms text NOT NULL DEFAULT '';
ALTER TABLE service_listings ADD COLUMN capability text NOT NULL DEFAULT '';
ALTER TABLE service_listings ADD COLUMN availability_note text NOT NULL DEFAULT '';
ALTER TABLE service_bookings ADD COLUMN task_id uuid;
ALTER TABLE service_bookings ADD CONSTRAINT booking_task_fk FOREIGN KEY(farm_id,task_id) REFERENCES tasks(farm_id,id);
ALTER TABLE service_bookings ADD COLUMN requested_quantity numeric(18,6);
ALTER TABLE service_bookings ADD COLUMN requested_unit text;
ALTER TABLE service_bookings ADD COLUMN quoted_quantity numeric(18,6);
ALTER TABLE service_bookings ADD COLUMN quoted_unit text;
ALTER TABLE service_bookings ADD COLUMN work_description text NOT NULL DEFAULT '';
ALTER TABLE service_bookings ADD COLUMN deposit_required numeric(18,2) NOT NULL DEFAULT 0 CHECK(deposit_required>=0);
ALTER TABLE service_bookings ADD COLUMN mobilisation_charge numeric(18,2) NOT NULL DEFAULT 0 CHECK(mobilisation_charge>=0);
ALTER TABLE booking_audit ADD COLUMN detail jsonb NOT NULL DEFAULT '{}';
CREATE TABLE service_work_records (
 id uuid PRIMARY KEY, booking_id uuid NOT NULL REFERENCES service_bookings(id), actor_id uuid NOT NULL REFERENCES users(id),
 observed_at timestamptz NOT NULL, quantity numeric(18,6) NOT NULL CHECK(quantity>0), unit text NOT NULL, note text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE service_payment_records (
 id uuid PRIMARY KEY, booking_id uuid NOT NULL REFERENCES service_bookings(id), actor_id uuid NOT NULL REFERENCES users(id), recorded_farm_id uuid NOT NULL REFERENCES farms(id),
 kind text NOT NULL CHECK(kind IN ('deposit','balance','refund')), amount numeric(18,2) NOT NULL CHECK(amount>0), currency text NOT NULL, note text NOT NULL,
 status text NOT NULL DEFAULT 'declared' CHECK(status IN ('declared','recorded','cancelled')),
 acknowledged_by uuid REFERENCES users(id), acknowledged_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE service_amendments (
 id uuid PRIMARY KEY, booking_id uuid NOT NULL REFERENCES service_bookings(id), booking_version integer NOT NULL,
 amount numeric(18,2) NOT NULL CHECK(amount>=0), currency text NOT NULL, reason text NOT NULL, work_description text NOT NULL,
 status text NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','accepted','rejected')),
 created_by uuid NOT NULL REFERENCES users(id), accepted_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), accepted_at timestamptz
);

-- Documented stock movement between stores/projects and identified birth cohorts.
CREATE TABLE stock_transfers (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), source_item_id uuid NOT NULL, destination_item_id uuid NOT NULL,
 source_quantity numeric(18,6) NOT NULL CHECK(source_quantity>0), source_unit text NOT NULL,
 destination_quantity numeric(18,6) NOT NULL CHECK(destination_quantity>0), destination_unit text NOT NULL,
 observed_at timestamptz NOT NULL, reason text NOT NULL, actor_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(source_item_id<>destination_item_id), FOREIGN KEY(farm_id,source_item_id) REFERENCES stock_items(farm_id,id), FOREIGN KEY(farm_id,destination_item_id) REFERENCES stock_items(farm_id,id)
);
CREATE TABLE stock_valuations (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), stock_item_id uuid NOT NULL,
 unit_cost numeric(18,6), currency text, source text NOT NULL, reason text NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((unit_cost IS NULL)=(currency IS NULL)), CHECK(unit_cost IS NULL OR unit_cost>=0), FOREIGN KEY(farm_id,stock_item_id) REFERENCES stock_items(farm_id,id)
);
ALTER TABLE animal_events ADD CONSTRAINT animal_events_farm_id_id UNIQUE(farm_id,id);
ALTER TABLE animal_identities ADD COLUMN birth_event_id uuid;
ALTER TABLE animal_identities ADD CONSTRAINT identity_birth_event_fk FOREIGN KEY(farm_id,birth_event_id) REFERENCES animal_events(farm_id,id);
ALTER TABLE animal_events ADD COLUMN historical_only boolean NOT NULL DEFAULT false;
ALTER TABLE animal_events ADD COLUMN source_project_version integer;
ALTER TABLE animal_events ADD COLUMN destination_project_version integer;
CREATE INDEX animal_events_source_sequence ON animal_events(farm_id,project_id,source_project_version);
CREATE INDEX animal_events_destination_sequence ON animal_events(farm_id,destination_project_id,destination_project_version);
