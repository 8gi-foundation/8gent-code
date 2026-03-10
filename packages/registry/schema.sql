-- 8gent Code - Primitives Registry Schema
-- SQLite database for storing design primitives, components, animations, and workflows

-- Core primitives table
CREATE TABLE IF NOT EXISTS primitives (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('component', 'animation', 'workflow', 'schema', 'pattern')),
  name TEXT NOT NULL,
  description TEXT,
  source TEXT NOT NULL,           -- file path or inline code
  source_type TEXT DEFAULT 'file', -- 'file', 'inline', 'url'
  language TEXT,                  -- 'typescript', 'css', 'json', etc.
  tags TEXT,                      -- JSON array of tags
  usage TEXT,                     -- example usage code
  dependencies TEXT,              -- JSON array of dependency IDs
  metadata TEXT,                  -- JSON object for extra data
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_primitives_type ON primitives(type);
CREATE INDEX IF NOT EXISTS idx_primitives_name ON primitives(name);
CREATE INDEX IF NOT EXISTS idx_primitives_language ON primitives(language);

-- Full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS primitives_fts USING fts5(
  name,
  description,
  tags,
  content=primitives,
  content_rowid=rowid
);

-- Trigger to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS primitives_ai AFTER INSERT ON primitives BEGIN
  INSERT INTO primitives_fts(rowid, name, description, tags)
  VALUES (new.rowid, new.name, new.description, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS primitives_ad AFTER DELETE ON primitives BEGIN
  INSERT INTO primitives_fts(primitives_fts, rowid, name, description, tags)
  VALUES ('delete', old.rowid, old.name, old.description, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS primitives_au AFTER UPDATE ON primitives BEGIN
  INSERT INTO primitives_fts(primitives_fts, rowid, name, description, tags)
  VALUES ('delete', old.rowid, old.name, old.description, old.tags);
  INSERT INTO primitives_fts(rowid, name, description, tags)
  VALUES (new.rowid, new.name, new.description, new.tags);
END;

-- Tool registry (for toolshed persistence)
CREATE TABLE IF NOT EXISTS tools (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  capabilities TEXT NOT NULL,     -- JSON array
  input_schema TEXT NOT NULL,     -- JSON schema
  output_schema TEXT,             -- JSON schema
  permissions TEXT NOT NULL,      -- JSON array
  source_file TEXT,               -- where the tool is defined
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tools_enabled ON tools(enabled);

-- Repo index cache
CREATE TABLE IF NOT EXISTS repo_indices (
  id TEXT PRIMARY KEY,
  source_root TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  file_count INTEGER,
  symbol_count INTEGER,
  languages TEXT,                 -- JSON object
  metadata TEXT                   -- JSON object
);

-- Symbol cache (for fast lookups)
CREATE TABLE IF NOT EXISTS symbols (
  id TEXT PRIMARY KEY,            -- e.g., "repo_id::path::symbolName"
  repo_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,             -- function, class, type, etc.
  start_line INTEGER,
  end_line INTEGER,
  signature TEXT,
  docstring TEXT,
  summary TEXT,
  FOREIGN KEY (repo_id) REFERENCES repo_indices(id)
);

CREATE INDEX IF NOT EXISTS idx_symbols_repo ON symbols(repo_id);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);

-- Full-text search for symbols
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  name,
  signature,
  summary,
  content=symbols,
  content_rowid=rowid
);

-- Session history
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT,
  working_directory TEXT,
  tokens_used INTEGER DEFAULT 0,
  tokens_saved INTEGER DEFAULT 0,
  commands_executed INTEGER DEFAULT 0
);

-- Command history
CREATE TABLE IF NOT EXISTS command_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  command TEXT NOT NULL,
  result TEXT,
  tokens_used INTEGER,
  tokens_saved INTEGER,
  executed_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_command_history_session ON command_history(session_id);
