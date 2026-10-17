-- Usage tracking for the admin panel's Metrics page (src/metrics.ts).

-- Every MCP request that does something: tool calls (tool = the tool's name) and new connections
-- (tool = 'initialize'). client is the AI app as it named itself (e.g. "claude-code", "Claude",
-- "ChatGPT"), when known. Rows outlive the account so history stays whole.
CREATE TABLE mcp_calls (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  email  TEXT NOT NULL,
  client TEXT,
  tool   TEXT NOT NULL,
  ok     INTEGER NOT NULL,              -- 0 when the tool answered with an error
  ms     INTEGER NOT NULL               -- how long the tool took
);
CREATE INDEX idx_mcp_calls_at ON mcp_calls(at);

-- People opening apps: one row per app, person and UTC day, counting the pages they loaded.
-- own = 1 when the person was the app's owner or an editor (building it), 0 when it was shared with
-- them (using it). No foreign key: visits to deleted apps still count in the history.
CREATE TABLE app_visits (
  site_id  TEXT NOT NULL,
  day      TEXT NOT NULL,               -- 'YYYY-MM-DD', UTC
  email    TEXT NOT NULL,
  own      INTEGER NOT NULL,
  views    INTEGER NOT NULL,
  first_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, day, email)
);
CREATE INDEX idx_app_visits_day ON app_visits(day);

-- The activity log by time, for the Metrics page's activity counts.
CREATE INDEX idx_audit_at ON audit(at);
