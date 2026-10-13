-- Keys for connected apps (services) a person's apps can use through Formelab, e.g. their
-- Google Gemini API key. Encrypted with SECRETS_KEK (AAD "user:<email>:<service>"); only the
-- last four characters are kept in the clear, to show which key it is. See src/gemini.ts.
CREATE TABLE service_keys (
  owner_email  TEXT NOT NULL REFERENCES users(email),
  service      TEXT NOT NULL,
  iv           TEXT NOT NULL,
  ciphertext   TEXT NOT NULL,
  hint         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  PRIMARY KEY (owner_email, service)
);
