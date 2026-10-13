-- The WorkOS session behind a Formelab sign-in (the access token's `sid`). Logging out ends it at
-- WorkOS too, so the next "Log in" asks for a code or password again instead of signing straight back in.
ALTER TABLE sessions ADD COLUMN workos_sid TEXT;
