-- The most Gemini calls an owner's apps may make in a UTC day, all apps and people together
-- (NULL = the default, 1,000). Set in Connected apps → Google Gemini. See src/gemini.ts.
ALTER TABLE service_keys ADD COLUMN daily_limit INTEGER;
