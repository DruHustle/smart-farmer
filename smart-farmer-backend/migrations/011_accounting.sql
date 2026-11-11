-- Reviewed invoice bookkeeping; existing operational records are not silently imported.
ALTER TABLE financial_entries ALTER COLUMN amount TYPE numeric(21,3);
ALTER TABLE financial_entries ADD CONSTRAINT financial_entries_farm_id_id UNIQUE(farm_id,id);

CREATE TABLE accounting_settings (
 farm_id uuid PRIMARY KEY REFERENCES farms(id), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 business jsonb NOT NULL, default_currency text NOT NULL CHECK(default_currency ~ '^[A-Z]{3}$'),
 invoice_prefix text NOT NULL, next_number bigint NOT NULL DEFAULT 1 CHECK(next_number BETWEEN 1 AND 1000000000),
 tax_rates jsonb NOT NULL DEFAULT '[]', locked_through date,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE accounting_accounts (
 farm_id uuid NOT NULL REFERENCES farms(id), code text NOT NULL, name text NOT NULL,
 type text NOT NULL CHECK(type IN('asset','liability','equity','income','expense')),
 system boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(farm_id,code)
);
CREATE TABLE accounting_documents (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), actor_id uuid NOT NULL REFERENCES users(id),
 mime_type text NOT NULL, filename text NOT NULL, size_bytes integer NOT NULL CHECK(size_bytes>0 AND size_bytes<=5242880),
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'), object_key text NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','processing','ready','failed')),
 extraction jsonb, error_code text, attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 lease_token uuid, lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(farm_id,id), UNIQUE(farm_id,content_hash), UNIQUE(object_key)
);
CREATE INDEX accounting_documents_queue ON accounting_documents(state,lease_until,created_at);
CREATE TABLE accounting_invoices (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), created_by uuid NOT NULL REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN('purchase','sale','purchase_credit','sale_credit')),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','posted','issued','void')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), content jsonb NOT NULL, snapshot jsonb,
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), minor_unit integer NOT NULL CHECK(minor_unit BETWEEN 0 AND 3),
 number text, supplier_key text NOT NULL DEFAULT '', reference_key text NOT NULL DEFAULT '',
 issue_date date NOT NULL, due_date date, total_minor numeric(24,0) NOT NULL CHECK(total_minor>=0),
 net_minor numeric(24,0) NOT NULL CHECK(net_minor>=0), tax_minor numeric(24,0) NOT NULL CHECK(tax_minor>=0),
 document_id uuid, source_entry_id uuid, financial_entry_id uuid, corrects_invoice_id uuid,
 finalized_at timestamptz, voided_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(farm_id,id), UNIQUE(farm_id,number), UNIQUE(farm_id,financial_entry_id),
 FOREIGN KEY(farm_id,document_id) REFERENCES accounting_documents(farm_id,id),
 FOREIGN KEY(farm_id,source_entry_id) REFERENCES financial_entries(farm_id,id),
 FOREIGN KEY(farm_id,financial_entry_id) REFERENCES financial_entries(farm_id,id),
 FOREIGN KEY(farm_id,corrects_invoice_id) REFERENCES accounting_invoices(farm_id,id),
 CHECK(due_date IS NULL OR due_date>=issue_date), CHECK(total_minor=net_minor+tax_minor),
 CHECK((status IN('draft','void') AND snapshot IS NULL AND finalized_at IS NULL) OR (status<>'draft' AND snapshot IS NOT NULL AND finalized_at IS NOT NULL)),
 CHECK((kind IN('purchase','purchase_credit') AND status IN('draft','posted','void')) OR (kind IN('sale','sale_credit') AND status IN('draft','issued','void')))
);
CREATE INDEX accounting_invoices_page ON accounting_invoices(farm_id,id DESC);
CREATE INDEX accounting_invoice_supplier_reference ON accounting_invoices(farm_id,supplier_key,reference_key);
CREATE UNIQUE INDEX accounting_invoice_source_once ON accounting_invoices(farm_id,source_entry_id) WHERE source_entry_id IS NOT NULL AND finalized_at IS NOT NULL AND status<>'void';
CREATE UNIQUE INDEX accounting_invoice_document_once ON accounting_invoices(farm_id,document_id) WHERE document_id IS NOT NULL AND finalized_at IS NOT NULL AND status<>'void' AND kind='purchase';

CREATE TABLE accounting_journals (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), created_by uuid NOT NULL REFERENCES users(id),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), minor_unit integer NOT NULL CHECK(minor_unit BETWEEN 0 AND 3),
 posted_on date NOT NULL, description text NOT NULL, reason text NOT NULL,
 source_kind text NOT NULL, source_id uuid NOT NULL, reversal_of uuid,
 created_xid bigint NOT NULL DEFAULT txid_current(), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(farm_id,id), UNIQUE(farm_id,source_kind,source_id), UNIQUE(reversal_of),
 FOREIGN KEY(farm_id,reversal_of) REFERENCES accounting_journals(farm_id,id)
);
CREATE TABLE accounting_journal_lines (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), journal_id uuid NOT NULL,
 position integer NOT NULL CHECK(position>=0), account_code text NOT NULL, project_id uuid,
 debit_minor numeric(24,0) NOT NULL DEFAULT 0 CHECK(debit_minor>=0),
 credit_minor numeric(24,0) NOT NULL DEFAULT 0 CHECK(credit_minor>=0), description text NOT NULL,
 UNIQUE(journal_id,position), FOREIGN KEY(farm_id,journal_id) REFERENCES accounting_journals(farm_id,id),
 FOREIGN KEY(farm_id,account_code) REFERENCES accounting_accounts(farm_id,code),
 FOREIGN KEY(farm_id,project_id) REFERENCES projects(farm_id,id),
 CHECK((debit_minor>0 AND credit_minor=0) OR (credit_minor>0 AND debit_minor=0))
);
CREATE INDEX accounting_journal_postings ON accounting_journals(farm_id,posted_on,id);
CREATE INDEX accounting_journal_account ON accounting_journal_lines(farm_id,account_code,journal_id);
CREATE TABLE accounting_payments (
 id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id), invoice_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id), amount_minor numeric(24,0) NOT NULL CHECK(amount_minor<>0),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), paid_on date NOT NULL,
 method text NOT NULL CHECK(method IN('cash','bank','mobile_money','other')),
 reference text NOT NULL DEFAULT '', note text NOT NULL DEFAULT '', origin text NOT NULL CHECK(origin IN('accounting','legacy')),
 legacy_entry_id uuid, reversal_of uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(farm_id,id), UNIQUE(invoice_id,legacy_entry_id), UNIQUE(reversal_of),
 FOREIGN KEY(farm_id,invoice_id) REFERENCES accounting_invoices(farm_id,id),
 FOREIGN KEY(farm_id,legacy_entry_id) REFERENCES financial_entries(farm_id,id),
 FOREIGN KEY(farm_id,reversal_of) REFERENCES accounting_payments(farm_id,id),
 CHECK(amount_minor>0 OR reversal_of IS NOT NULL OR origin='legacy')
);
CREATE INDEX accounting_payments_invoice ON accounting_payments(farm_id,invoice_id,paid_on,id);

CREATE FUNCTION accounting_immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'accounting history is immutable; append a reversal' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER accounting_journal_immutable BEFORE UPDATE OR DELETE ON accounting_journals FOR EACH ROW EXECUTE FUNCTION accounting_immutable_record();
CREATE TRIGGER accounting_line_immutable BEFORE UPDATE OR DELETE ON accounting_journal_lines FOR EACH ROW EXECUTE FUNCTION accounting_immutable_record();
CREATE TRIGGER accounting_payment_immutable BEFORE UPDATE OR DELETE ON accounting_payments FOR EACH ROW EXECUTE FUNCTION accounting_immutable_record();
CREATE FUNCTION accounting_line_current_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM accounting_journals WHERE farm_id=NEW.farm_id AND id=NEW.journal_id AND created_xid=txid_current()) THEN
  RAISE EXCEPTION 'cannot append to a committed journal' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER accounting_line_insert BEFORE INSERT ON accounting_journal_lines FOR EACH ROW EXECUTE FUNCTION accounting_line_current_transaction();
CREATE FUNCTION accounting_check_journal_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer; debit numeric; credit numeric;
BEGIN
 SELECT count(*),COALESCE(sum(debit_minor),0),COALESCE(sum(credit_minor),0) INTO n,debit,credit FROM accounting_journal_lines WHERE journal_id=NEW.id;
 IF n<2 OR debit<>credit THEN RAISE EXCEPTION 'unbalanced accounting journal' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER accounting_journal_balance AFTER INSERT ON accounting_journals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION accounting_check_journal_balance();
CREATE FUNCTION accounting_preserve_invoice_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'invoice history cannot be deleted' USING ERRCODE='23514'; END IF;
 IF (OLD.finalized_at IS NOT NULL OR OLD.status='void') AND (NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.content IS DISTINCT FROM OLD.content OR
   NEW.id<>OLD.id OR NEW.farm_id<>OLD.farm_id OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at OR
   NEW.kind<>OLD.kind OR NEW.currency<>OLD.currency OR NEW.minor_unit<>OLD.minor_unit OR NEW.number IS DISTINCT FROM OLD.number OR
   NEW.total_minor<>OLD.total_minor OR NEW.net_minor<>OLD.net_minor OR NEW.tax_minor<>OLD.tax_minor OR
   NEW.document_id IS DISTINCT FROM OLD.document_id OR NEW.source_entry_id IS DISTINCT FROM OLD.source_entry_id OR
   NEW.financial_entry_id IS DISTINCT FROM OLD.financial_entry_id OR NEW.corrects_invoice_id IS DISTINCT FROM OLD.corrects_invoice_id OR
   NEW.issue_date<>OLD.issue_date OR NEW.due_date IS DISTINCT FROM OLD.due_date OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at) THEN
  RAISE EXCEPTION 'finalized invoice snapshot is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER accounting_invoice_snapshot BEFORE UPDATE OR DELETE ON accounting_invoices FOR EACH ROW EXECUTE FUNCTION accounting_preserve_invoice_snapshot();
