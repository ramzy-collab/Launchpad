-- App members (agent access spec step 4): people added inside an app with formelab.roles.set, each
-- with a role from its access rules (formelab.json). Being on the list lets them open the app. The
-- owner, editors and share list aren't stored here; a row for someone on the share list only
-- changes their role. Deleted with the app (removeSite in src/sites.ts).
CREATE TABLE app_members (
  site_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  added_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, email)
);
CREATE INDEX app_members_email ON app_members (email);
