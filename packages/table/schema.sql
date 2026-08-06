-- 8gent Table schema (Phase 1, contract section 1.3).
-- Applied on open with IF NOT EXISTS so reopen is idempotent.

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
  visibility TEXT NOT NULL, topic TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  channel_id TEXT NOT NULL, participant_id TEXT NOT NULL, role TEXT NOT NULL, added_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, participant_id),
  FOREIGN KEY (channel_id) REFERENCES channels(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, author_id TEXT NOT NULL,
  content TEXT NOT NULL, reply_to TEXT, sig TEXT, edited_at INTEGER, deleted_at INTEGER, created_at INTEGER NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(reply_to);
CREATE INDEX IF NOT EXISTS idx_members_participant ON members(participant_id);

-- FTS5 mirror (external-content pattern like the memory store).
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content, content='messages', content_rowid='rowid'
);

-- Sync triggers. Soft-delete blanks content to '' via UPDATE, which the
-- update trigger mirrors into the FTS index, so tombstoned rows stop matching.
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
