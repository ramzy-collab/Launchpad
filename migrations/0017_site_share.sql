-- The app's link preview image (what iMessage, Slack and others show for its link): NULL = not
-- looked for yet, '' = none (a card is drawn for it), a file path inside the app, a small data: URI
-- or an https URL from index.html. See src/share.ts.
ALTER TABLE sites ADD COLUMN share_path TEXT;
