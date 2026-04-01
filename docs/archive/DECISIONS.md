# 8gent Code - Architecture Decisions

Locked decisions for the initial implementation.

---

## 1. TUI Framework: Ink

**Choice:** [Ink](https://github.com/vadimdemedes/ink) - React for CLI

**Why:**
- Familiar JSX/React patterns
- Component-based UI composition
- Good ecosystem (ink-text-input, ink-select, etc.)
- Active maintenance
- Works great with Bun

**Dependencies:**
```json
{
  "ink": "^4.0.0",
  "ink-text-input": "^5.0.0",
  "ink-select-input": "^5.0.0",
  "ink-spinner": "^5.0.0",
  "react": "^18.0.0"
}
```

---

## 2. Parser Strategy: Hybrid

**Choice:** TypeScript Compiler API for TS/JS, tree-sitter for everything else

**Why:**
- TypeScript API gives us perfect TS/JS parsing with zero native deps
- tree-sitter covers Rust, Go, Python, etc. when needed
- Avoids heavyweight native bindings for the common case (TS/JS)

**Implementation:**
```typescript
function getParser(language: string): Parser {
  if (language === "typescript" || language === "javascript") {
    return new TypeScriptParser();
  }
  return new TreeSitterParser(language);
}
```

**Dependencies:**
```json
{
  "typescript": "^5.0.0",
  "tree-sitter": "^0.21.0",
  "tree-sitter-rust": "^0.21.0",
  "tree-sitter-python": "^0.21.0",
  "tree-sitter-go": "^0.21.0"
}
```

---

## 3. Sandbox Strategy: Docker → Unikraft

**Choice:** Docker containers locally, Unikraft microVMs in production

**Why (Stripe approach):**
- Docker is familiar, works everywhere, easy to debug
- Unikraft microVMs in prod for security + speed
- Clear upgrade path from dev to prod

**Local Development:**
```typescript
interface LocalSandbox {
  type: "docker";
  image: string;
  volumes: string[];
  networkMode: "none" | "bridge";
}
```

**Production:**
```typescript
interface ProdSandbox {
  type: "unikraft";
  kernel: string;
  memory: number;
  timeout: number;
}
```

---

## 4. Primitive Registry: SQLite

**Choice:** SQLite database for primitives

**Why:**
- Fast, embedded, zero server
- Queryable (search by tag, type, name)
- Single file, easy to backup/sync
- Scales to millions of rows

**Schema:**
```sql
CREATE TABLE primitives (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,        -- component, animation, workflow, schema
  name TEXT NOT NULL,
  description TEXT,
  source TEXT NOT NULL,      -- file path or inline code
  tags TEXT,                 -- JSON array
  usage TEXT,                -- example usage
  created_at TEXT,
  updated_at TEXT
);

CREATE INDEX idx_primitives_type ON primitives(type);
CREATE INDEX idx_primitives_name ON primitives(name);
CREATE VIRTUAL TABLE primitives_fts USING fts5(name, description, tags);
```

**Seed Data:**
- Components from `~/Myresumeportfolio/design`
- Animation primitives from existing projects
- Successful patterns from FoodstackOS, iris-observatory

---

## 5. Coexistence: 8gent Code alongside Claude Code

**Choice:** Separate tool, coexists until it surpasses Claude Code

**Why:**
- Claude Code is battle-tested, don't break what works
- 8gent Code is experimental, needs room to evolve
- Eventually 8gent Code becomes the primary tool

**Paths:**
- Claude Code: `~/.claude/`
- 8gent Code: `~/8gent-code/` (dev), `~/.8gent/` (runtime)

**Integration Points:**
- Can share skills format
- Can import existing hooks
- Independent tool registries

---

## Marketing Angle

**Problem:** "Cursor AI Pro Users Hit Usage Caps After Few Hours of Coding" (686 posts trending on X)

**Solution:** 8gent Code uses AST-first retrieval, reducing token usage by 80%+

**Tagline ideas:**
- "Never hit usage caps again"
- "Code more with less"
- "Structured retrieval, infinite capacity"
- "The agent that doesn't burn through your quota"
