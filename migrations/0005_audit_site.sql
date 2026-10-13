-- Ties each activity row to the app it happened in, so every app has its own activity log.
-- Rows not about an app (accounts, admin, namespaces, connections) keep site_id NULL and show
-- up in the admin panel's activity log instead.
ALTER TABLE audit ADD COLUMN site_id TEXT;
UPDATE audit SET site_id = json_extract(detail, '$.siteId') WHERE detail IS NOT NULL AND json_valid(detail) AND action <> 'delete_site';
CREATE INDEX idx_audit_site ON audit(site_id, id);
