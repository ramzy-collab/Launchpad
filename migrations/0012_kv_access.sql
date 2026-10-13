-- Who may change an app's shared data (KV): 'all' (everyone who can open the app) or 'editors'
-- (its owner and editors). Apps that existed before this keep 'all'; new apps start as 'editors'.
ALTER TABLE sites ADD COLUMN kv_writes TEXT NOT NULL DEFAULT 'all';

-- Each person's private data in an app (formelab.kv.mine): only that person can read or change it.
CREATE TABLE kv_user (
  site_id    TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,                 -- JSON
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, email, key)
);
