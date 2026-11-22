-- The app's parsed access rules (formelab.json) as JSON, kept at publish so each formelab.kv call
-- can apply them without reading the file (see rulesOfSite in src/sites.ts). NULL when it has none,
-- or for apps published with rules before this column, whose rules are read from the file once.
ALTER TABLE sites ADD COLUMN rules TEXT;
