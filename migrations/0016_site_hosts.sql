-- Each app gets its own host, <host_label>.APP_DOMAIN (e.g. hoops-7kq2.formelab.app), so browsers
-- keep apps apart: before this, every app in a namespace shared <namespace>.APP_DOMAIN as one
-- origin. The label is the app's name plus a 4-character code from an alphabet without look-alike
-- characters (no 0/o, 1/l/i). Nobody owns a name; the code makes each label unique.
ALTER TABLE sites ADD COLUMN host_label TEXT;

-- Existing apps: name from the mount path ("/" becomes "-"), or the namespace for a root app.
UPDATE sites SET host_label =
  rtrim(substr(CASE WHEN mount_path = '' THEN namespace ELSE replace(mount_path, '/', '-') END, 1, 40), '-')
  || '-'
  || substr('abcdefghjkmnpqrstuvwxyz23456789', (abs(random()) % 31) + 1, 1)
  || substr('abcdefghjkmnpqrstuvwxyz23456789', (abs(random()) % 31) + 1, 1)
  || substr('abcdefghjkmnpqrstuvwxyz23456789', (abs(random()) % 31) + 1, 1)
  || substr('abcdefghjkmnpqrstuvwxyz23456789', (abs(random()) % 31) + 1, 1)
WHERE host_label IS NULL;

CREATE UNIQUE INDEX idx_sites_host_label ON sites(host_label);
