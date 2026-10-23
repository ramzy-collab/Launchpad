-- Results of the feature test plans in docs/test-plans (admin panel, Test plans): one row per
-- case, the latest result only. `plan` is the plan's file name without .md.
CREATE TABLE test_results (
  plan TEXT NOT NULL,
  case_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'blocked')),
  notes TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'page',
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (plan, case_id)
);
