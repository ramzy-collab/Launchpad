-- Responses: what people send an app with formelab.responses.submit() (form answers, sign-ups,
-- feedback). Anyone who can open the app may send one; only its owner and editors can read them.
-- email is NULL for guests (people who opened the app through its public link). See src/responses.ts.
-- Listed in rowid order (the order they arrived): ids made in the same millisecond don't sort.
CREATE TABLE responses (
  id      TEXT PRIMARY KEY,               -- "r_" + random id
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  at      INTEGER NOT NULL,
  email   TEXT,
  data    TEXT NOT NULL                   -- JSON
);
CREATE INDEX idx_responses_site ON responses(site_id);

-- Whether guests let in by the app's public link may send responses (1) or only look (0, the default).
ALTER TABLE sites ADD COLUMN guest_responses INTEGER NOT NULL DEFAULT 0;
