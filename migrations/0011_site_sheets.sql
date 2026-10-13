-- The Google spreadsheets an app may use through its owner's Google Sheets connection
-- (JSON array of spreadsheet ids). Only the app's owner sets it; spreadsheets the owner creates
-- through the app are added automatically. See src/sheets.ts.
ALTER TABLE sites ADD COLUMN sheets TEXT NOT NULL DEFAULT '[]';
