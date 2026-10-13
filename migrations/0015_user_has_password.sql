-- Whether someone has a password at WorkOS, as far as Formelab knows: set when they set one on the
-- Password page, reset it, or log in with one. The login page asks people with a password for it
-- and emails everyone else a code.
ALTER TABLE users ADD COLUMN has_password INTEGER NOT NULL DEFAULT 0;
UPDATE users SET has_password = 1 WHERE email IN (SELECT actor FROM audit WHERE action = 'password_set');
