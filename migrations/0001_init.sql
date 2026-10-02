CREATE TABLE users (
  email       TEXT PRIMARY KEY,
  name        TEXT,
  is_admin    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE namespaces (
  label       TEXT PRIMARY KEY,             -- e.g. "ramzy"
  owner_email TEXT NOT NULL REFERENCES users(email),
  editors     TEXT NOT NULL DEFAULT '[]',   -- JSON array of emails
  created_at  INTEGER NOT NULL
);

CREATE TABLE sites (
  id              TEXT PRIMARY KEY,         -- random id, e.g. "s_" + 16 base32 chars
  namespace       TEXT NOT NULL REFERENCES namespaces(label),
  mount_path      TEXT NOT NULL,            -- "" for root, else "a" or "a/b"
  title           TEXT,
  owner_email     TEXT NOT NULL,
  editors         TEXT NOT NULL DEFAULT '[]',
  visibility      TEXT NOT NULL DEFAULT 'all',   -- 'all' | 'restricted'
  allowed_emails  TEXT NOT NULL DEFAULT '[]',
  hidden          INTEGER NOT NULL DEFAULT 0,    -- hidden from listings only
  spa             INTEGER NOT NULL DEFAULT 0,
  current_version TEXT NOT NULL,            -- R2 prefix version id
  file_count      INTEGER NOT NULL,
  total_bytes     INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (namespace, mount_path)
);

CREATE TABLE kv (
  site_id    TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,                 -- JSON
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, key)
);

CREATE TABLE secrets (
  site_id    TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  iv         TEXT NOT NULL,                 -- base64, 12 bytes
  ciphertext TEXT NOT NULL,                 -- base64, AES-256-GCM
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, name)
);

CREATE TABLE tokens (
  id          TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  name        TEXT NOT NULL,
  hash        TEXT NOT NULL UNIQUE,         -- sha256 hex of the full token
  expires_at  INTEGER NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0,
  last_used   INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,                 -- publish, delete_site, secret_set, ...
  target     TEXT,
  detail     TEXT                           -- JSON, never secret values
);
