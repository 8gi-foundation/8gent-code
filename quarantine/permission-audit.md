# quarantine: permission-audit

**Status:** Ready for review
**File:** `packages/permissions/audit-log.ts`
**Branch:** `quarantine/permission-audit`

---

## What this does

Adds a persistent SQLite audit trail for every NemoClaw permission check. Zero changes to existing files.

`AuditLog` class - SQLite-backed, WAL mode, one row per permission evaluation.

### Schema

```sql
audit_entries (
  id               INTEGER PK AUTOINCREMENT,
  ts               TEXT,    -- ISO-8601
  action           TEXT,    -- PolicyActionType or raw string
  tool             TEXT,    -- first token of command / file / action
  decision         TEXT,    -- allow | block | require_approval | approved | denied
  rule_matched     TEXT,    -- policy rule name that triggered, if any
  context_snapshot TEXT,    -- sanitised PolicyContext JSON (no secrets, max 2KB)
  prompted         INTEGER, -- was user prompted
  infinite_mode    INTEGER, -- was infinite mode active
  eval_ms          REAL,    -- policy evaluation time
  session_id       TEXT     -- optional grouping key
)
```

Indexes on `ts`, `tool`, `decision`, `session_id`.

---

## API surface

```ts
import { AuditLog, getAuditLog } from "@8gent/permissions/audit-log";

const audit = new AuditLog();           // or getAuditLog() for singleton

// Record any permission check
audit.record({ action, tool, decision, rule_matched, context_snapshot, ... });

// Convenience wrapper for policy engine results
audit.recordPolicyCheck({ action, context, decision, ruleMatched, evalMs, sessionId });

// Query
audit.query({ tool?, decision?, since?, until?, limit? });
audit.queryByTool("bash");
audit.queryByDecision("block");
audit.queryByTime(new Date("2026-01-01"));

// Escalation detection - tools with elevated require_approval/denied rates
audit.escalationPatterns({ since: new Date("2026-03-24"), minCount: 2 });

// Export
const report = audit.exportReport({ since, until });  // structured JSON
const md     = audit.exportMarkdown();                 // Markdown table report

// Maintenance
audit.prune(90);  // delete entries older than 90 days
audit.close();
```

---

## Integration point

Wire into `policy-engine.ts` `evaluatePolicy()` after the decision is made:

```ts
import { getAuditLog } from "./audit-log.js";

// Inside evaluatePolicy(), after decision is determined:
getAuditLog().recordPolicyCheck({
  action,
  context,
  decision: result.allowed ? "allow" : (result.requiresApproval ? "require_approval" : "block"),
  ruleMatched: matchedRule?.name,
  evalMs: performance.now() - start,
  sessionId: process.env.EIGHT_SESSION_ID,
});
```

Wire into `PermissionManager.requestPermission()` for the human-approval path:

```ts
getAuditLog().record({
  action,
  tool: command ?? action,
  decision: approved ? "approved" : "denied",
  rule_matched: null,
  context_snapshot: JSON.stringify({ command, details }),
  prompted: true,
  infinite_mode: this.isInfiniteMode(),
  eval_ms: 0,
  session_id: null,
});
```

Integration is intentionally NOT wired in this PR - this is a quarantine changeset to review the audit schema and API before coupling it to live policy evaluation.

---

## What is NOT in scope

- No changes to `policy-engine.ts` or `index.ts`
- No TUI reporting widget
- No Convex sync
- No rate-limiting on audit writes

---

## Security notes

- Context snapshots redact any field whose key contains `password`, `token`, `secret`, `key`, `api_key`, `auth`, or `credential`
- `content` fields truncated at 200 chars before storing
- Total snapshot capped at 2KB
- WAL mode - safe for concurrent reads during agent sessions

---

## Success metric

`audit.count()` increments per policy check; `exportReport()` returns a non-empty `by_decision` map after a session runs.
