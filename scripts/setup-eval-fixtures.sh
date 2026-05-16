#!/bin/bash
# Minimal eval fixture set for Day-3 judge eval gate.
#
# Synthesizes the smallest set of files needed for fixture-dependent tasks
# in eval/go-task-set-v1.jsonl. Synthetic data, not real PII. Idempotent.
#
# Owner: 8PO (Samantha). Built 2026-05-16 because the canonical fixture
# script referenced in eval/README.md does not yet exist in this branch.

set -euo pipefail

FIXTURES="/tmp/eval-fixtures"
rm -rf "$FIXTURES"
mkdir -p "$FIXTURES"/{dedupe,photos,code,docs,data,comms,pr}

# ----- dedupe -----------------------------------------------------------------
# go-003: dedupe by content hash
echo "alpha content" > "$FIXTURES/dedupe/a1.txt"
echo "beta content"  > "$FIXTURES/dedupe/b1.txt"
echo "gamma content" > "$FIXTURES/dedupe/c1.txt"
sleep 0.05; echo "alpha content" > "$FIXTURES/dedupe/a2.txt"  # newer dup
sleep 0.05; echo "beta content"  > "$FIXTURES/dedupe/b2.txt"  # newer dup

# ----- photos -----------------------------------------------------------------
# go-004: rename to YYYY-MM-DD_<name>
for n in IMG_001.jpg IMG_002.jpg IMG_003.jpg vacation.png screenshot.png; do
  echo "fake jpeg bytes for $n" > "$FIXTURES/photos/$n"
done

# ----- code -------------------------------------------------------------------
# go-007: failing test for sum() bug
cat > "$FIXTURES/code/sum.ts" <<'EOF'
// Off-by-one bug: returns a+b+1 instead of a+b
export function sum(a: number, b: number): number {
  return a + b + 1;
}
EOF
cat > "$FIXTURES/code/package.json" <<'EOF'
{ "name": "fixture-code", "type": "module" }
EOF

# go-008: duplicated date-formatting
cat > "$FIXTURES/code/formatters.ts" <<'EOF'
// Both functions duplicate the same date-formatting logic. Refactor.
export function formatDateA(d: Date): string {
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
}
export function formatDateB(date: Date): string {
  return date.getFullYear() + "-" + String(date.getMonth()+1).padStart(2,"0") + "-" + String(date.getDate()).padStart(2,"0");
}
EOF

# go-009: api validation
cat > "$FIXTURES/code/api.ts" <<'EOF'
export function createUser(name: string, email: string) {
  // missing validation
  return { id: Math.random(), name, email };
}
EOF

# go-010: off-by-one in parser
cat > "$FIXTURES/code/parser.ts" <<'EOF'
// Subtle off-by-one when slicing the tail token: drops one char
export function parseTokens(input: string): string[] {
  const parts = input.split(",");
  return parts.map((p, i) => (i === parts.length - 1 ? p.slice(0, -1) : p));
}
EOF

# ----- docs -------------------------------------------------------------------
# go-012: long spec to summarize
cat > "$FIXTURES/docs/long-spec.md" <<'EOF'
# Hypothetical API Spec v0.1

## Auth
All requests require a bearer token. Tokens rotate every 24 hours.
The /auth/rotate endpoint returns a new pair.

## Rate limiting
100 requests per minute per token. Bursts up to 200. Returns 429 on cap.
Backoff is exponential starting at 1 second.

## Pagination
Cursor-based. Pass `?cursor=...` from the previous response's `next_cursor`.

## Errors
All errors return JSON {code, message, request_id}. Codes are stable strings.
Never numeric.

## Webhooks
Endpoints register at /webhooks. Payloads are signed HMAC-SHA256.
Verify with the shared secret. Reject anything older than 5 minutes.
EOF

# ----- data -------------------------------------------------------------------
# go-014: contacts.csv normalisation
cat > "$FIXTURES/data/contacts.csv" <<'EOF'
name,email,phone
  Alice  , Alice@Example.com ,  555-0101
Bob,  bob@example.com , 555-0102
Alice,alice@example.com,555-0101
  Charlie ,charlie@EXAMPLE.com,555-0103
EOF

# go-015: events.jsonl filter
cat > "$FIXTURES/data/events.jsonl" <<'EOF'
{"ts":"2026-05-01T10:00:00Z","type":"info","msg":"start"}
{"ts":"2026-05-01T10:05:00Z","type":"error","msg":"disk full"}
{"ts":"2026-05-01T10:10:00Z","type":"warn","msg":"degraded"}
{"ts":"2026-05-01T10:15:00Z","type":"error","msg":"oom"}
{"ts":"2026-05-01T10:20:00Z","type":"info","msg":"recovered"}
EOF

# go-016: pii scrub
cat > "$FIXTURES/data/leaky.log" <<'EOF'
2026-05-01 10:00:01 user=alice@example.com ip=192.168.1.50 token=Bearer abc123 logged in
2026-05-01 10:00:02 user=bob@example.com ip=10.0.0.5 action=read
2026-05-01 10:00:03 user=charlie@example.com ip=172.16.5.2 token=Bearer xyz789 logged out
2026-05-01 10:00:04 health-check ok
EOF

# go-017: merge sales-q1 + sales-q2
cat > "$FIXTURES/data/sales-q1.csv" <<'EOF'
month,product,units,revenue
2026-01,widget,100,1000
2026-02,widget,150,1500
2026-03,gadget,80,1600
EOF
cat > "$FIXTURES/data/sales-q2.csv" <<'EOF'
month,product,units,revenue
2026-04,widget,120,1200
2026-05,gadget,90,1800
2026-06,gadget,110,2200
EOF

# ----- comms ------------------------------------------------------------------
# go-018: lisa pitch
cat > "$FIXTURES/comms/lisa-original-pitch.md" <<'EOF'
Subject: 8gent for your support workflows

Hi Lisa,

Following up on the conversation last week about how your team handles inbound
support tickets. 8gent is an autonomous coding agent that runs locally; it can
triage tickets, draft replies, and run small fixes against your codebase
without any cloud dependency. The local-first design means PII never leaves
your machines.

Happy to walk through a 15-minute demo. Mornings work best for me this week.

James
EOF

# ----- pr ---------------------------------------------------------------------
# go-019: pr diff
cat > "$FIXTURES/pr/diff.patch" <<'EOF'
diff --git a/packages/goal/goal-loop.ts b/packages/goal/goal-loop.ts
new file mode 100644
--- /dev/null
+++ b/packages/goal/goal-loop.ts
@@ -0,0 +1,5 @@
+export class GoalLoop {
+  // outer loop wrapping executor + judge
+}
diff --git a/apps/tui/src/commands/go.ts b/apps/tui/src/commands/go.ts
new file mode 100644
--- /dev/null
+++ b/apps/tui/src/commands/go.ts
@@ -0,0 +1,3 @@
+export async function runGo(prompt: string) {}
diff --git a/docs/specs/GO-RECEIPT.md b/docs/specs/GO-RECEIPT.md
new file mode 100644
--- /dev/null
+++ b/docs/specs/GO-RECEIPT.md
@@ -0,0 +1,1 @@
+# Receipt spec
EOF

echo "[fixtures] synthesized at $FIXTURES"
ls -la "$FIXTURES"
