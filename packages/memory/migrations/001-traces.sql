-- 001-traces.sql
-- Computer-use trace capture (Phase 4).
-- Local-only; no sync. Screenshots stored on disk; rows reference the path.

CREATE TABLE IF NOT EXISTS computer_use_traces (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  channel             TEXT NOT NULL,
  intent              TEXT NOT NULL,
  started_at          INTEGER NOT NULL,
  ended_at            INTEGER,
  outcome             TEXT
                      CHECK (outcome IS NULL OR outcome IN ('ok','error','timeout','aborted')),
  step_count          INTEGER NOT NULL DEFAULT 0,
  summary             TEXT,
  -- Dispatch provenance (per feedback_dispatch_everywhere.md, 8gent-code#1896).
  -- Nullable for local sessions that did not arrive via the dispatch protocol.
  originating_channel TEXT,
  dispatch_source     TEXT,
  dispatch_id         TEXT
);

CREATE INDEX IF NOT EXISTS idx_traces_session ON computer_use_traces(session_id);
CREATE INDEX IF NOT EXISTS idx_traces_channel ON computer_use_traces(channel);
CREATE INDEX IF NOT EXISTS idx_traces_started ON computer_use_traces(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_traces_dispatch_source ON computer_use_traces(dispatch_source);

CREATE TABLE IF NOT EXISTS computer_use_trace_steps (
  id              TEXT PRIMARY KEY,
  trace_id        TEXT NOT NULL REFERENCES computer_use_traces(id) ON DELETE CASCADE,
  step_index      INTEGER NOT NULL,
  perception_kind TEXT NOT NULL
                  CHECK (perception_kind IN ('tree','screenshot','none')),
  screenshot_path TEXT,
  tool_call_name  TEXT,
  tool_call_args  TEXT,
  tool_result     TEXT,
  tokens_used     INTEGER NOT NULL DEFAULT 0,
  ms              INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  UNIQUE (trace_id, step_index)
);

CREATE INDEX IF NOT EXISTS idx_trace_steps_trace ON computer_use_trace_steps(trace_id, step_index);
