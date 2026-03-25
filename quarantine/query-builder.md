# Quarantine: query-builder

**Status:** Under review
**Package:** `packages/memory/query-builder.ts`
**Branch:** `quarantine/query-builder`

## What it does

Fluent SQLite query builder. Zero external dependencies. Supports:

- SELECT (with DISTINCT, column list, or `*`)
- INSERT / INSERT OR REPLACE
- UPDATE with SET
- DELETE
- Parameter binding (positional `?` - SQLite standard)
- JOIN (INNER, LEFT, LEFT OUTER, CROSS)
- FTS5 MATCH
- WHERE with AND chaining, IN list, IS NULL, IS NOT NULL
- GROUP BY / HAVING
- ORDER BY (ASC/DESC)
- LIMIT / OFFSET
- RETURNING clause
- clone() and reset() helpers

## API

```ts
import { QueryBuilder } from "../packages/memory/query-builder";

// SELECT
const { sql, params } = new QueryBuilder()
  .select("id", "content", "created_at")
  .from("memories")
  .where("user_id = ?", "user-123")
  .where("type = ?", "episodic")
  .orderBy("created_at", "DESC")
  .limit(20)
  .offset(0)
  .build();

// FTS5 MATCH
const { sql, params } = new QueryBuilder()
  .select("rowid", "content")
  .from("memories_fts")
  .ftsMatch("memories_fts", "neural networks")
  .orderBy("rank")
  .limit(10)
  .build();

// LEFT JOIN
const { sql, params } = new QueryBuilder()
  .select("m.id", "m.content", "u.name")
  .from("memories m")
  .leftJoin("users u", "u.id = m.user_id")
  .where("m.decayed = ?", 0)
  .build();

// INSERT with RETURNING
const { sql, params } = new QueryBuilder()
  .insertInto("memories", ["user_id", "content", "type"], ["user-123", "content text", "episodic"])
  .returning("id")
  .build();

// INSERT OR REPLACE
const { sql, params } = new QueryBuilder()
  .insertInto("memories", ["id", "content"], [existingId, newContent])
  .orReplace()
  .build();

// UPDATE
const { sql, params } = new QueryBuilder()
  .update("memories")
  .set("content", "updated text")
  .set("updated_at = datetime('now')")
  .where("id = ?", memoryId)
  .returning("id", "updated_at")
  .build();

// DELETE
const { sql, params } = new QueryBuilder()
  .deleteFrom("memories")
  .where("expires_at < ?", Date.now())
  .build();

// WHERE IN
const { sql, params } = new QueryBuilder()
  .select()
  .from("memories")
  .whereIn("id", ["id-1", "id-2", "id-3"])
  .build();

// Clone for building variants from a common base
const base = new QueryBuilder().select().from("memories").where("user_id = ?", userId);
const recent = base.clone().orderBy("created_at", "DESC").limit(5).build();
const older  = base.clone().orderBy("created_at", "ASC").limit(5).build();
```

## Design decisions

- Conditions are AND-only. OR logic: `.where("a = ? OR b = ?", x, y)`.
- FTS5 MATCH is a special WHERE condition - table name must match the FTS virtual table.
- No schema awareness. Typos caught at runtime by SQLite.
- No validation beyond required fields. Keeps the implementation simple.
- clone() is shallow-copy safe because Param values are primitives.

## Integration path

When graduating from quarantine, re-export from `packages/memory/index.ts`:

```ts
export { QueryBuilder } from "./query-builder";
```

Primary candidates for migration: `store.ts`, `recall.ts`, `consolidation.ts`.

## What this is NOT

- Not an ORM. No schema, no migrations, no model classes.
- Not a query planner. No optimization hints.
- Not async. Returns `{ sql, params }` synchronously.
