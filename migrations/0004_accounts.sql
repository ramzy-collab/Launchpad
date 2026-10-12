-- Formelab's own login (WorkOS AuthKit) and account status.

-- 'active' accounts can create namespaces and publish; 'waitlisted' ones can only open apps that
-- were shared with them. Everyone who signed in before this migration came through the Access
-- allow-list, so they stay active.
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN workos_id TEXT;

-- When an admin lets someone in from the waitlist (or invites them). They become active on their
-- next sign-in, or right away if they already have an account.
ALTER TABLE waitlist ADD COLUMN approved_at INTEGER;

-- Browser sessions. The cookie holds a random token; only its SHA-256 is stored. Each session
-- belongs to one host: the apex (dashboard) or a namespace host, which gets its own session,
-- created from an apex session through a one-time code (see auth_codes).
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,                 -- sha256 hex of the cookie token
  email      TEXT NOT NULL REFERENCES users(email),
  host       TEXT NOT NULL,
  parent_id  TEXT,                             -- namespace-host sessions: the apex session
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_email ON sessions(email);
CREATE INDEX idx_sessions_parent ON sessions(parent_id);

-- One-time codes that hand a signed-in apex session to a namespace host. Single use, 60 seconds.
CREATE TABLE auth_codes (
  id         TEXT PRIMARY KEY,                 -- sha256 hex of the code
  session_id TEXT NOT NULL,
  host       TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Apps are private by default now: only the owner, editors and the people they are shared with
-- can open them. Existing apps follow the new default.
UPDATE sites SET visibility = 'restricted' WHERE visibility = 'all';
