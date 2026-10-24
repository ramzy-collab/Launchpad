-- Stars: each person's own starred apps, shown first in My apps and Shared with me.
CREATE TABLE app_stars (
  user_email TEXT NOT NULL,
  site_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_email, site_id)
);
CREATE INDEX app_stars_site ON app_stars (site_id);

-- Editors and Admins need a Formelab account. Someone invited as one before they have an account
-- gets a sign-up invite: they're a viewer until they join, then the role is applied and the row
-- removed (see sharing.ts applyPendingInvites).
CREATE TABLE pending_role_invites (
  site_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('editor', 'admin')),
  invited_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, email)
);
CREATE INDEX pending_role_invites_email ON pending_role_invites (email);

-- 1: the owner of the app's space also counts as an owner of the app (the default). 0 after the
-- app is handed to someone else (transfer ownership): the space owner is then an Admin like anyone.
ALTER TABLE sites ADD COLUMN space_owner_powers INTEGER NOT NULL DEFAULT 1;
