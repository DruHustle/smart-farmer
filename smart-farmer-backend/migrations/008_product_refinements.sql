-- Additive refinements after the published product checkpoint.
ALTER TABLE opening_financial_balances ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE expense_allocations ADD COLUMN reversed_at timestamptz;
ALTER TABLE expense_allocations ADD COLUMN reversed_by uuid REFERENCES users(id);
CREATE TABLE financial_corrections (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), entry_id uuid NOT NULL UNIQUE REFERENCES financial_entries(id),
 reason text NOT NULL, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE market_listings ADD COLUMN price_quantity numeric(18,6) NOT NULL DEFAULT 1 CHECK(price_quantity>0);
