-- What link previews (Slack, iMessage, WhatsApp...) show for an app: 'full' (its name, description
-- and picture) or 'private' (a plain Formelab card that names nothing). NULL means decide from who
-- can open it: full for apps open to all Formelab members or with a public link, private otherwise.
-- See src/share.ts.
ALTER TABLE sites ADD COLUMN link_preview TEXT;

-- The most responses guests from the public link may send the app in a UTC day (people who are
-- signed in don't count). See src/responses.ts.
ALTER TABLE sites ADD COLUMN guest_responses_per_day INTEGER NOT NULL DEFAULT 500;
