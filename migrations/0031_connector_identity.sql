-- Each person's identity sent to Supabase (agent access spec step 6b, src/supabaseid.ts). A connector
-- with identity 'supabase' sends its key as the apikey header and, with every call, a short-lived
-- token naming the signed-in person, signed with the connector's own key pair. Formelab is the
-- token's issuer (<aiOrigin>/oidc/c/<id>), which the owner registers in Supabase as a Custom OIDC
-- third-party auth provider. The private key is encrypted like connector keys; turning identity
-- off deletes the pair, so turning it on again makes a new one.
ALTER TABLE connectors ADD COLUMN identity TEXT;
ALTER TABLE connectors ADD COLUMN signing_kid TEXT;
ALTER TABLE connectors ADD COLUMN signing_public TEXT;
ALTER TABLE connectors ADD COLUMN signing_iv TEXT;
ALTER TABLE connectors ADD COLUMN signing_private TEXT;
