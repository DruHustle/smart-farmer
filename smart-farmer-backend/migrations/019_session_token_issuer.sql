-- Existing sessions were minted by the authority in their user's onesa_issuer.
-- The account issuer remains the stable historical namespace for Farmer records.
ALTER TABLE sessions ADD COLUMN onesa_token_issuer text;
