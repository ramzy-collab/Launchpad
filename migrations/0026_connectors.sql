-- Custom connectors: a person saves a service's API key once, says where it may be sent and how,
-- and the apps built to use it call the service through Formelab without ever seeing the key
-- (see src/connectors.ts). Behind the connected_apps flag.
CREATE TABLE connectors (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  name TEXT NOT NULL,                 -- what apps ask for: lowercase letters, digits, "_" or "-"
  label TEXT NOT NULL,                -- what people see, like "Quo"
  description TEXT NOT NULL DEFAULT '',
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,           -- the key as JSON (a string, or an object for older saved keys), AAD "connector:<id>"
  hint TEXT NOT NULL DEFAULT '',      -- its last 4 characters
  hosts TEXT NOT NULL,                -- JSON array: the only hosts it's sent to
  auth TEXT NOT NULL CHECK (auth IN ('bearer', 'header', 'query', 'placeholder')),
  auth_name TEXT NOT NULL DEFAULT '', -- the header or query parameter, for 'header' and 'query'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (owner_email, name)
);

-- Which connectors each app was built to use, as a JSON array of names: its owner's connector of
-- that name, or "gemini" for Google Gemini. An app can't use a connector that isn't listed.
ALTER TABLE sites ADD COLUMN connectors TEXT NOT NULL DEFAULT '[]';

-- Apps that have already used Gemini were built to use it.
UPDATE sites SET connectors = '["gemini"]' WHERE id IN (SELECT DISTINCT site_id FROM audit WHERE action = 'gemini' AND site_id IS NOT NULL);
