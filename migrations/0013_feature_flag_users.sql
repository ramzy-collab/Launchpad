-- People a feature is turned on for one by one (admin panel → Features), whatever the flag's
-- state. See src/flags.ts.
CREATE TABLE feature_flag_users (
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  added_at   INTEGER NOT NULL,
  added_by   TEXT,
  PRIMARY KEY (name, email)
);
CREATE INDEX feature_flag_users_email ON feature_flag_users (email);
