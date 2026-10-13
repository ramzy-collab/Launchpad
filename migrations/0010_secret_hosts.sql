-- Hosts each secret may be sent to through the proxy (JSON array of host names; "*.x.com"
-- matches subdomains of x.com). NULL marks a secret stored before host lists existed: the proxy
-- refuses it until an owner or editor sets it again with hosts.
ALTER TABLE secrets ADD COLUMN hosts TEXT;
