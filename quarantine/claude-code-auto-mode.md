# Quarantine Spec: Claude Code Auto Mode

**Date:** 2026-03-25
**Status:** Research / Competitive Analysis
**Sources:** Anthropic blog, TechCrunch, 9to5Mac, Anthropic engineering blog

---

## What Auto Mode Does

Claude Code's default behavior requires user approval for every file write and bash command. Auto mode is a middle path between that conservative default and `--dangerously-skip-permissions` (which skips everything).

### Core mechanism

Before each tool call executes, an AI classifier reviews it to determine risk:

- **Auto-approved:** Safe operations proceed without user intervention
- **Blocked:** Risky operations are prevented; Claude is redirected to try an alternative approach
- **Escalated:** If Claude repeatedly insists on blocked actions, a permission prompt surfaces to the user

### What the classifier checks for

- Mass file deletion
- Sensitive data exfiltration
- Malicious code execution
- Actions outside the scope of what the user requested
- Signs of prompt injection in the action chain

### Activation

- CLI: `claude --enable-auto-mode`, then toggle with Shift+Tab
- Desktop/VS Code: Settings toggle, then permission mode dropdown
- Admin disable: `"disableAutoMode": "disable"` in managed settings

### Tradeoffs

- Small overhead per tool call (classifier inference adds latency and tokens)
- Can still allow risky actions when user intent is ambiguous
- Can occasionally block benign actions (false positives)
- Only works with Sonnet 4.6 and Opus 4.6
- Anthropic recommends use in isolated environments only

### Sandboxing layer (separate but related)

Anthropic also ships OS-level sandboxing using Linux bubblewrap and macOS seatbelt:
- Filesystem isolation to working directory only
- Network traffic routed through Unix domain socket proxy with domain allowlists
- Internal testing showed 84% reduction in permission prompts with sandboxing
- Git credentials stay external to the sandbox

---

## How 8gent Compares

### 8gent's current permission system (NemoClaw)

| Layer | What it does |
|-------|-------------|
| `PermissionManager` (index.ts) | Token-based command parsing, dangerous command detection, pattern matching, infinite mode with 30-min expiry |
| `PolicyEngine` (policy-engine.ts) | YAML-driven rules with condition DSL (contains, in, equals, starts_with, ends_with), 3-tier decisions (allow/block/require_approval) |
| `default-policies.yaml` | 11 default rules covering secrets, destructive commands, git protections, network exfil, config deletion |
| Infinite Mode | Time-limited bypass (30 min) with audit log, catastrophic commands still blocked |
| Headless Mode | Auto-approves safe read-only commands, denies dangerous ones, no TTY needed |

### Key differences

| Aspect | Claude Code Auto Mode | 8gent NemoClaw |
|--------|----------------------|----------------|
| **Classification** | AI classifier per tool call | Static rule matching (YAML conditions + hardcoded lists) |
| **Granularity** | Semantic intent analysis | Pattern-based (command tokens, file paths, content strings) |
| **False positives** | Lower (AI understands context) | Higher (pattern matching is blunt) |
| **Latency** | Higher (inference per action) | Near-zero (string matching) |
| **Cost** | Token overhead per action | Zero additional cost |
| **Bypass mode** | Auto mode IS the middle path | Infinite mode is full bypass (with audit) |
| **Sandbox** | OS-level (bubblewrap/seatbelt) | None (relies on rule engine only) |
| **Configurability** | Admin toggle only | Full YAML customization, user overrides, runtime rule injection |
| **Audit** | Unclear | Full audit log in infinite mode |

---

## What We Can Learn

### 1. Add a "smart auto" mode between conservative and infinite

8gent's current modes are binary: either ask for everything, or allow everything (infinite mode). Auto mode proves there is demand for a middle tier that auto-approves safe actions and blocks risky ones without user input.

**Action:** Create an `auto` preset for NemoClaw that expands the safe-list beyond read-only commands to include common write operations (file writes within project dir, git commits, package installs) while keeping destructive operations gated.

### 2. Context-scoped permissions

Claude Code's classifier considers whether an action fits the user's stated intent. NemoClaw currently has no concept of task context - it evaluates each action in isolation.

**Action (future):** Pass task description into PolicyContext so rules can condition on intent. Not worth building today without evidence of demand.

### 3. Filesystem boundary enforcement

The sandbox's filesystem isolation is a strong idea. NemoClaw rules check file paths but don't enforce a boundary.

**Action:** Add a `project_root_only` policy rule that blocks writes outside the working directory. Simple, no OS-level sandbox needed.

### 4. Escalation after repeated blocks

If Claude keeps hitting blocks, it escalates to the user. NemoClaw just blocks and the agent retries or fails.

**Action (future):** Add a block counter per session. After N blocks on the same action type, surface a prompt. Low priority.

---

## Competitive Position

**8gent's advantages:**
- Full YAML customizability - users own their policy, not a black box classifier
- Zero-cost evaluation - no token overhead per action
- Infinite mode with audit trail - full transparency
- Open source - users can inspect and modify the engine
- Works with any model, not locked to specific model versions

**8gent's gaps:**
- No semantic understanding of actions (pattern matching only)
- No filesystem sandbox (rule-based only)
- No middle-tier auto mode (binary: ask everything or allow everything)
- No network isolation

**Strategy:** Ship the `auto` preset to close the biggest gap (missing middle tier). Filesystem boundary rule is a quick win. Semantic classification is not worth the cost for a local-first tool - keep it rules-based but smarter.
