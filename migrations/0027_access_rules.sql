-- Access rules (formelab.json, see src/rules.ts). Apps made from now on must have rules once they
-- save shared data or use connected services; apps that existed before this keep publishing
-- without them and get a warning on their settings page instead.
ALTER TABLE sites ADD COLUMN rules_required INTEGER NOT NULL DEFAULT 0;

-- What the last publish's scan found, as JSON ({kv, prefixes, dynamic, sheets, connectors, rules,
-- invites}). NULL until the app is next published or its settings page scans it.
ALTER TABLE sites ADD COLUMN access TEXT;
