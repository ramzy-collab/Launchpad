-- Feature flags, set in the admin panel (Features). A flag with no row is off. See src/flags.ts.
CREATE TABLE feature_flags (
  name       TEXT PRIMARY KEY,
  state      TEXT NOT NULL CHECK (state IN ('off', 'admins', 'on')),
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
