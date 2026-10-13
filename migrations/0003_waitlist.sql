-- Email sign-ups from the public home page.
CREATE TABLE waitlist (
  email      TEXT PRIMARY KEY,              -- normalized (trimmed, lowercased)
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_waitlist_created ON waitlist(created_at);
