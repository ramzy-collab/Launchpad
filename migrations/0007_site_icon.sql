-- The app's icon (favicon or logo) for the web app's tiles: NULL = not looked for yet,
-- '' = none, a file path inside the app, or a small data: URI. See src/icons.ts.
ALTER TABLE sites ADD COLUMN icon_path TEXT;
