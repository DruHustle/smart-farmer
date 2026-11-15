ALTER TABLE users
 ADD COLUMN onesa_issuer text,
 ADD COLUMN onesa_subject uuid,
 ADD COLUMN onesa_vault_key text,
 ADD CONSTRAINT onesa_account UNIQUE (onesa_issuer, onesa_subject),
 ADD CONSTRAINT onesa_account_complete CHECK (
  (onesa_issuer IS NULL AND onesa_subject IS NULL AND onesa_vault_key IS NULL) OR
  (onesa_issuer IS NOT NULL AND onesa_subject IS NOT NULL AND onesa_vault_key IS NOT NULL AND password_hash = '!')
 );
ALTER TABLE sessions ADD COLUMN onesa_grant text;
