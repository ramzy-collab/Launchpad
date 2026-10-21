-- Editors the owner lets change who can open the app (visibility, share list, public link and
-- link previews), as a JSON array of emails. Other editors can update the app but not share it.
-- See canShareSite in src/auth.ts.
ALTER TABLE sites ADD COLUMN sharers TEXT NOT NULL DEFAULT '[]';
