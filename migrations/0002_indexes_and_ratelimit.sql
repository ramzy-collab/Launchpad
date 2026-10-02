-- Lookups the Worker does on every request or listing.
CREATE INDEX idx_sites_namespace ON sites(namespace);
CREATE INDEX idx_tokens_owner ON tokens(owner_email);
CREATE INDEX idx_audit_actor_at ON audit(actor, at);
CREATE INDEX idx_audit_target_at ON audit(target, at);

-- Fallback fixed-window counter for the secret proxy, used only when the
-- PROXY_LIMITER rate-limiting binding is not configured.
CREATE TABLE rate_counters (
  bucket     TEXT PRIMARY KEY,              -- "<site_id>:<minute>"
  count      INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
