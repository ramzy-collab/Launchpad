-- Calls to one app's own address for AI tools (<app-host>/mcp, agent access spec step 5) carry the
-- app's id, so Metrics can tell them from calls to Formelab's own connector (site_id NULL).
ALTER TABLE mcp_calls ADD COLUMN site_id TEXT;
