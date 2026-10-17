-- "Anyone with the link": a secret token that lets people open an app without signing in, at
-- https://<host_label>.APP_DOMAIN/_platform/link/<token>. NULL means the app has no public link. Making a
-- new link replaces the token, so the old link (and every visitor it let in) stops working.
ALTER TABLE sites ADD COLUMN public_link TEXT;
