-- Additive only: existing delivery status, attempts, IDs and receipts retain
-- their meaning. Previously attempted rows have no reconstructible envelope;
-- the worker holds those rows for reconciliation instead of guessing one.
ALTER TABLE notification_deliveries
 ADD COLUMN request_cipher jsonb,
 ADD COLUMN request_body_hash text,
 ADD COLUMN request_prepared_at timestamptz,
 ADD CONSTRAINT notification_request_complete CHECK (
   (request_cipher IS NULL AND request_body_hash IS NULL AND request_prepared_at IS NULL)
   OR (request_cipher IS NOT NULL AND jsonb_typeof(request_cipher) = 'object'
       AND request_body_hash IS NOT NULL AND request_body_hash ~ '^[a-f0-9]{64}$'
       AND request_prepared_at IS NOT NULL)
 );
