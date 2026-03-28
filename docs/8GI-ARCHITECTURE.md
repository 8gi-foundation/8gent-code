# 8GI Technical Architecture

**Author:** Rishi, CTO - 8gent
**Date:** 2026-03-26
**Version:** 1.0
**Status:** Draft

> This document specifies the technical architecture of 8GI - the polyglot ethical hive mind. It covers everything from a new member's first `./setup.sh` to how anonymised usage patterns flow back into the collective without ever exposing personal data.

---

## 1. Setup Script Architecture

### What `8gi-setup/setup.sh` does

The setup script is the single entry point for onboarding a new circle member. It is idempotent - safe to re-run. Every step is logged to `~/.8gent/setup.log`.

**Step-by-step execution:**

```
Step 1: Environment Detection
  - Detect OS (macOS / Linux distro)
  - Detect shell (zsh / bash / fish)
  - Detect existing toolchain (node, bun, git, ollama)
  - Write platform profile to ~/.8gent/platform.json

Step 2: Runtime Installation
  - Install Bun (if missing): curl -fsSL https://bun.sh/install | bash
  - Install Ollama (if missing): platform-specific installer
  - Pull default model: ollama pull qwen3.5 (3.8GB, runs on 8GB RAM)
  - Verify: bun --version, ollama list

Step 3: 8gent Installation
  - npm install -g @podjamz/8gent-code
  - Verify: 8gent --version
  - Create ~/.8gent/ data directory
  - Initialize SQLite memory store: ~/.8gent/memory.db
  - Write default config: ~/.8gent/config.json

Step 4: NemoClaw Policy Deployment
  - Copy 8gi-circle-policies.yaml to ~/.8gent/policies.yaml
  - This is the STRICT circle template (see Section 3)
  - Infinite mode DISABLED (interactive approval only)
  - Audit logging ENABLED

Step 5: Factory Pipeline Configuration
  - Configure anonymised telemetry endpoint (opt-in prompt)
  - Set member ID (UUID, not tied to identity)
  - Write factory-config to ~/.8gent/factory-sync.json
  - Default: local-only mode, no outbound sync

Step 6: Git & GitHub Configuration
  - Verify GitHub CLI (gh) is authenticated
  - Request GitHub org invitation acceptance (PodJamz/8gi-circle)
  - Configure git commit signing (recommended, not required)
  - Set default branch protection awareness

Step 7: Companion System Bootstrap
  - Initialize companion data: ~/.8gent/companion/
  - Assign starter species (random from Common pool)
  - Generate companion deck seed

Step 8: Verification
  - Run smoke test: 8gent launches, connects to Ollama, loads policies
  - Run policy test: attempt blocked command, confirm denial
  - Run memory test: write + read episodic memory
  - Print: "Your setup is ready. Welcome to 8GI."
  - Send Telegram welcome to circle group (if member opted in)
```

**Script structure:**

```bash
#!/usr/bin/env bash
set -euo pipefail

SETUP_LOG="$HOME/.8gent/setup.log"
mkdir -p "$HOME/.8gent"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1" | tee -a "$SETUP_LOG"; }

# Each step is a function. Failures are non-fatal (logged + continued).
# The verification step at the end reports what succeeded and what needs attention.

step_detect_environment
step_install_runtimes
step_install_8gent
step_deploy_policies
step_configure_factory
step_configure_git
step_bootstrap_companion
step_verify
```

---

## 2. 8gent - The Official Tool

### Agent Architecture

8gent is the official AI coding tool of the 8GI collective. It runs locally on each member's machine with no subscription required.

Members are free to use any editor or AI tool they prefer alongside 8gent for their personal workflow. 8gent is what the collective standardizes on.

```
┌─────────────────────────────────────────────────────┐
│  Member's Machine                                    │
│                                                      │
│  ┌──────────────────────────────────────────┐       │
│  │  8gent                                    │       │
│  │  (Local-first, free)                      │       │
│  │                                           │       │
│  │  - Ollama local models (qwen3 default)    │       │
│  │  - OpenRouter free cloud (fallback)       │       │
│  │  - Persistent memory store (SQLite)       │       │
│  │  - NemoClaw policy engine                 │       │
│  │  - Companion system                       │       │
│  │  - Factory pipeline integration           │       │
│  └────────────────────┬─────────────────────┘       │
│                       │                               │
│              ┌────────▼────────┐                      │
│              │  Data Layer      │                      │
│              │                  │                      │
│              │  ~/.8gent/       │ Config, memory,      │
│              │  ~/projects/     │ policies, codebases  │
│              └─────────────────┘                      │
└─────────────────────────────────────────────────────┘
```

**Capabilities:**

| Aspect | Details |
|--------|---------|
| **Model** | Local (Ollama) or free cloud (OpenRouter) |
| **Cost** | Free |
| **Strength** | Fast iteration, memory persistence, autonomous loops, policy enforcement |
| **Memory** | Persistent (SQLite, survives restarts) |
| **Policies** | NemoClaw built into agent loop |
| **Companion** | Session-aware coding companion that evolves with usage |

**Filesystem layout:**

```
~/.8gent/                     # 8gent data
  config.json                 # Agent configuration
  memory.db                   # SQLite memory store
  policies.yaml               # NemoClaw policies
  companion/                  # Companion state
  factory-sync.json           # Anonymised pattern sync config
  kernel/                     # RL fine-tuning data (if enabled)
```

---

## 3. NemoClaw Security Policy Template for Circle Members

Circle members receive a strict policy template that is more restrictive than the default 8gent policies. The philosophy: deny by default, allow explicitly, approve interactively for grey areas.

### `8gi-circle-policies.yaml`

```yaml
version: 1

# 8GI Circle - Enterprise Security Policy
# This policy is MANDATORY for all circle members.
# Modifications require approval from James (CAO).
#
# Philosophy: deny-by-default. Every allowed action is explicit.
# Infinite mode is DISABLED. All grey-area actions require interactive approval.

policies:

  # ── HARD BLOCKS (no bypass) ────────────────────────────────────────────

  - name: "block-secrets-in-code"
    action: write_file
    condition: >
      content contains API_KEY or content contains SECRET
      or content contains PASSWORD or content contains TOKEN
      or content contains PRIVATE_KEY or content contains AWS_
      or content contains ANTHROPIC_API or content contains OPENAI_API
    decision: block
    message: "Secrets in code are blocked. Use .env + process.env."

  - name: "block-rm-rf"
    action: run_command
    condition: "command contains rm -rf /"
    decision: block
    message: "Recursive root delete blocked."

  - name: "block-fork-bomb"
    action: run_command
    condition: "command contains :(){ :|:"
    decision: block
    message: "Fork bomb blocked."

  - name: "block-force-push-protected"
    action: run_command
    condition: >
      command contains git push --force and command contains main
      or command contains git push -f and command contains main
      or command contains git push --force and command contains master
      or command contains git push -f and command contains master
    decision: block
    message: "Force push to protected branches is permanently blocked."

  - name: "block-sudo-destructive"
    action: run_command
    condition: "command contains sudo rm or command contains sudo mkfs or command contains sudo dd"
    decision: block
    message: "Destructive sudo operations blocked."

  - name: "block-eval-in-code"
    action: write_file
    condition: "content contains eval( or content contains Function("
    decision: block
    message: "eval() and Function() are blocked in generated code."

  - name: "block-exfil-domains"
    action: network_request
    condition: >
      url contains pastebin.com or url contains ngrok.io
      or url contains requestbin or url contains pipedream.com
      or url contains webhook.site
    decision: block
    message: "Request to known data exfiltration domain blocked."

  - name: "block-crypto-mining"
    action: run_command
    condition: >
      command contains xmrig or command contains minerd
      or command contains ethminer or command contains cryptonight
    decision: block
    message: "Cryptocurrency mining commands blocked."

  - name: "block-network-scan"
    action: run_command
    condition: "command contains nmap or command contains masscan or command contains nikto"
    decision: block
    message: "Network scanning tools blocked."

  # ── APPROVAL REQUIRED (interactive confirmation) ───────────────────────

  - name: "approve-env-writes"
    action: write_file
    condition: "path contains .env and content contains ="
    decision: require_approval
    message: "Writing to .env file requires your confirmation."

  - name: "approve-pipe-to-shell"
    action: run_command
    condition: >
      command contains |sh or command contains |bash
      or command contains |zsh or command contains | sh
      or command contains | bash or command contains | zsh
      or command contains curl | or command contains wget |
    decision: require_approval
    message: "Piping to shell requires your confirmation."

  - name: "approve-git-reset"
    action: run_command
    condition: "command contains git reset --hard or command contains git clean -f"
    decision: require_approval
    message: "Destructive git operation requires your confirmation."

  - name: "approve-push-to-main"
    action: git_push
    condition: "branch in [main, master, production, prod, release]"
    decision: require_approval
    message: "Push to protected branch requires your confirmation."

  - name: "approve-npm-publish"
    action: run_command
    condition: "command contains npm publish or command contains bun publish"
    decision: require_approval
    message: "Publishing to npm requires your confirmation."

  - name: "approve-docker-commands"
    action: run_command
    condition: >
      command contains docker run or command contains docker exec
      or command contains docker build
    decision: require_approval
    message: "Docker operations require your confirmation."

  - name: "approve-file-deletion"
    action: delete_file
    condition: >
      path contains package.json or path contains tsconfig
      or path contains CLAUDE.md or path contains .yaml
      or path contains .yml or path contains policies
    decision: require_approval
    message: "Deleting config or policy files requires your confirmation."

  - name: "approve-desktop-automation"
    action: desktop_use
    condition: "action in [click, type, press, drag, clipboard_set]"
    decision: require_approval
    message: "Desktop automation requires your confirmation."

  # ── EXPLICIT ALLOWS (safe operations) ──────────────────────────────────

  - name: "allow-read-only-desktop"
    action: desktop_use
    condition: >
      action equals screenshot or action equals window_list
      or action equals display_list or action equals hover
      or action equals scroll or action equals clipboard_get
    decision: allow
    message: "Read-only desktop actions allowed."

  - name: "allow-safe-commands"
    action: run_command
    condition: >
      command starts_with git status or command starts_with git log
      or command starts_with git diff or command starts_with git branch
      or command starts_with ls or command starts_with cat
      or command starts_with bun test or command starts_with bun run
      or command starts_with tsc or command starts_with node --version
      or command starts_with bun --version
    decision: allow
    message: "Safe read-only command allowed."

# ── GLOBAL SETTINGS ────────────────────────────────────────────────────

settings:
  infinite_mode: false        # MANDATORY for circle members
  audit_logging: true         # All decisions logged to ~/.8gent/audit.jsonl
  default_decision: block     # Anything not explicitly allowed is denied
  max_approval_timeout: 60    # Seconds before auto-deny on approval prompts
```

### Audit Trail

Every policy decision is appended to `~/.8gent/audit.jsonl`:

```json
{
  "timestamp": "2026-03-26T10:15:23Z",
  "action": "run_command",
  "command": "git push origin feature/my-work",
  "policy": "allow-safe-commands",
  "decision": "allow",
  "context": { "branch": "feature/my-work", "cwd": "/home/user/project" }
}
```

This log never leaves the member's machine. James can request aggregate statistics (see Section 10) but never raw audit data.

---

## 4. Factory Pipeline Per-Member

### How Usage Patterns Feed Back (Anonymised)

Each circle member's 8gent generates local usage data. The factory pipeline collects anonymised signals - never code, never personal data, never file contents.

```
┌──────────────────────────────────────────────────────────┐
│  Member's Machine (LOCAL ONLY)                            │
│                                                           │
│  8gent session -> tool calls -> memory writes -> patterns │
│                                                           │
│  Pattern Extractor (runs locally):                        │
│  - Which tool categories used most (e.g., "async", "fs") │
│  - Which abilities succeeded vs failed                    │
│  - Average session length and task type                   │
│  - Model performance (latency, success rate)              │
│                                                           │
│  Output: ~/.8gent/patterns/weekly-digest.json             │
└──────────────────────┬───────────────────────────────────┘
                       │
                       │ OPT-IN sync (member must explicitly enable)
                       │ HTTP POST to 8gi-patterns.fly.dev
                       │ Payload is the digest only, never raw data
                       │
              ┌────────▼────────────────┐
              │  8GI Pattern Aggregator  │
              │  (Fly.io Amsterdam)      │
              │                          │
              │  Receives digests from   │
              │  all opted-in members    │
              │                          │
              │  Produces:               │
              │  - Popularity rankings   │
              │  - Failure hot spots     │
              │  - Category demand       │
              │  - Model recommendations │
              └────────┬────────────────┘
                       │
              ┌────────▼────────────────┐
              │  Factory Discovery       │
              │  (James's machine)       │
              │                          │
              │  Aggregated patterns     │
              │  become one of 6 input   │
              │  sources for the AAIP    │
              │  discovery phase         │
              └─────────────────────────┘
```

### Weekly Digest Schema

```json
{
  "memberId": "uuid-not-tied-to-identity",
  "period": "2026-W13",
  "toolUsage": {
    "file_read": 342,
    "file_write": 128,
    "run_command": 256,
    "git_operations": 89,
    "memory_query": 67,
    "browser_fetch": 23
  },
  "abilityUsage": {
    "debounce-v2": 12,
    "priority-queue": 8,
    "retry-with-backoff": 5
  },
  "failures": {
    "timeout": 3,
    "policy_block": 7,
    "model_error": 1
  },
  "modelPerformance": {
    "ollama_qwen3.5": { "avgLatency": 4200, "successRate": 0.94 },
    "openrouter_free": { "avgLatency": 1800, "successRate": 0.91 }
  },
  "sessionCount": 18,
  "avgSessionMinutes": 22
}
```

**What is NOT in the digest:**
- File paths or filenames
- Code snippets or content
- Git commit messages or diffs
- Memory contents (episodic or semantic)
- Credentials or environment variables
- IP addresses or hostnames
- Personal identifiers (name, email, GitHub handle)

### Anonymisation Guarantees

1. **Member ID is a random UUID** generated at setup. Not derived from email, GitHub, or machine ID.
2. **k-anonymity threshold:** Digests are only sent if the member has > 50 data points in the period. Low-activity members produce no signal (prevents fingerprinting).
3. **Differential noise:** Tool usage counts have +/- 5% random noise added before transmission.
4. **No correlation attack:** The aggregator receives digests without auth headers, IP logging, or session cookies. It is a write-only endpoint.

---

## 5. PR Flow: Quarantine Branch Pipeline

### End-to-End Flow

```
Member's 8gent generates code
         │
         ▼
┌─────────────────────────┐
│ 1. LOCAL VALIDATION      │
│    - NemoClaw policy     │
│      gate (no eval,      │
│      no secrets, etc.)   │
│    - TypeScript syntax   │
│      check (bun)         │
│    - Line count check    │
│      (max 250)           │
└────────┬────────────────┘
         │ PASS
         ▼
┌─────────────────────────┐
│ 2. QUARANTINE BRANCH     │
│    - Branch: quarantine/ │
│      {member}/{name}     │
│    - Commit: factory     │
│      metadata in message │
│    - Push to origin      │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ 3. AUTOMATED CI          │
│    (GitHub Actions)      │
│                          │
│    - Security scan       │
│    - Type check          │
│    - Lint                │
│    - Test (if present)   │
│    - Dependency audit    │
│    - CODEOWNERS check    │
└────────┬────────────────┘
         │ ALL GREEN
         ▼
┌─────────────────────────┐
│ 4. GITHUB PR CREATED     │
│    - Template enforced   │
│    - Labels auto-applied │
│    - Reviewers assigned  │
│    - Telegram notif sent │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ 5. HUMAN REVIEW          │
│    - James (initially)   │
│    - Trusted engineers   │
│      (as circle grows)   │
│    - Checklist:          │
│      readability,        │
│      correctness,        │
│      edge cases,         │
│      no dead code        │
└────────┬────────────────┘
         │ APPROVED
         ▼
┌─────────────────────────┐
│ 6. MERGE TO MAIN         │
│    - Merge commit (not   │
│      squash - preserve   │
│      factory provenance) │
│    - Branch deleted       │
│    - CHANGELOG updated    │
│    - Telegram confirm     │
└─────────────────────────┘
```

### Branch Naming Convention

```
quarantine/{member-handle}/{utility-name}

Examples:
  quarantine/rishi/retry-with-backoff
  quarantine/factory/debounce-v2          # factory-generated (no human author)
  quarantine/sarah/custom-logger
```

### PR Template (enforced via `.github/PULL_REQUEST_TEMPLATE.md`)

```markdown
## Ability: {name}

### What
{One-line description}

### Source
- [ ] Factory-generated (AAIP pipeline)
- [ ] Member-authored
- [ ] Hybrid (factory-generated, member-refined)

### Security Gate
- [ ] NemoClaw local validation PASSED
- [ ] No eval(), require(), process.env mutation
- [ ] Under 250 lines
- [ ] Zero external dependencies

### Tests
- [ ] Tests included ({count} test cases)
- [ ] Tests pass locally (`bun test`)

### Review Checklist
- [ ] Code is readable and maintainable
- [ ] Error handling present
- [ ] Edge cases from spec addressed
- [ ] No conflicts with existing packages/tools/

### Generated by
{agent name} on {timestamp} | Model: {model name}
```

---

## 6. CI/CD Pipeline Requirements

### GitHub Actions Workflow

Inspired by enterprise compliance pipelines. Every PR triggers this pipeline. No exceptions.

```yaml
# .github/workflows/8gi-ci.yml
name: 8GI Circle CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  # ── Stage 1: Static Analysis (parallel) ──────────────────────
  security-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Secret Scanner
        # Scan for leaked credentials, API keys, tokens
        run: |
          bun run scripts/ci/secret-scanner.ts
      - name: Pattern Blocklist
        # Check for eval(), require(), process.env mutation
        run: |
          bun run scripts/ci/pattern-blocklist.ts
      - name: Dependency Audit
        # Check for known vulnerabilities in any new deps
        run: |
          bun audit --production

  type-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run typecheck

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run lint

  # ── Stage 2: Tests (after static analysis passes) ────────────
  test:
    needs: [security-scan, type-check, lint]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun test
      - name: Coverage Report
        run: bun test --coverage

  # ── Stage 3: Policy Validation ───────────────────────────────
  policy-gate:
    needs: [test]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: NemoClaw CI Validation
        # Validates all new/changed files against circle policies
        run: |
          bun run scripts/ci/policy-gate.ts --diff ${{ github.event.pull_request.base.sha }}
      - name: Line Count Enforcement
        # No single file > 250 lines (200-line discipline)
        run: |
          bun run scripts/ci/line-count-check.ts --max 250
      - name: Provenance Check
        # Verify factory-generated code has proper metadata
        run: |
          bun run scripts/ci/provenance-check.ts

  # ── Stage 4: Approval Gate ───────────────────────────────────
  approval-check:
    needs: [policy-gate]
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    steps:
      - name: Require Human Approval
        # Blocks merge until a CODEOWNER approves
        # Auto-merge is DISABLED org-wide
        run: echo "Waiting for human review..."

  # ── Stage 5: Post-Merge (main branch only) ──────────────────
  post-merge:
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    runs-on: ubuntu-latest
    needs: [test]
    steps:
      - uses: actions/checkout@v4
      - name: Benchmark Regression
        run: bun run benchmark:v2 --compare HEAD~1
      - name: Changelog Verification
        run: |
          bun run scripts/ci/changelog-check.ts
      - name: Telegram Notification
        env:
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}
        run: |
          bun run scripts/ci/notify-merge.ts
```

### Required Status Checks (Branch Protection)

All of these must pass before merge is allowed:

| Check | Type | Blocks Merge |
|-------|------|:---:|
| `security-scan` | Secret detection + pattern blocklist | Yes |
| `type-check` | TypeScript compilation | Yes |
| `lint` | Code style enforcement | Yes |
| `test` | Unit + integration tests | Yes |
| `policy-gate` | NemoClaw + line count + provenance | Yes |
| `approval-check` | At least 1 CODEOWNER approval | Yes |

### Secrets Management in CI

- No secrets in repository code (scanner enforces this)
- GitHub Actions secrets for Telegram notifications only
- No cloud API keys in CI (Ollama not needed in CI - code is already generated)
- Bun lockfile frozen in CI (`--frozen-lockfile`) to prevent supply chain attacks

---

## 7. Polyglot Strategy

### Bootstrapping 8gent-py, 8gent-rs, 8gent-go

8GI is polyglot by design. The TypeScript implementation (8gent-code) is the reference. Other languages follow the same architecture, reusing the protocol layer.

```
┌──────────────────────────────────────────────────────┐
│  SHARED PROTOCOL LAYER                                │
│  (language-agnostic, JSON over stdio/WebSocket)       │
│                                                       │
│  - Daemon Protocol v1.0 (session, auth, streaming)    │
│  - NemoClaw policy format (YAML, same schema)         │
│  - Memory schema (SQLite, same tables)                │
│  - Factory digest format (JSON, same structure)        │
│  - Tool interface (JSON-RPC tool calls)                │
└──────────────────────────────────────────────────────┘
         │                │                │
    ┌────▼────┐     ┌────▼────┐     ┌────▼────┐
    │ 8gent   │     │ 8gent   │     │ 8gent   │
    │ -code   │     │ -py     │     │ -rs     │
    │ (TS)    │     │ (Py)    │     │ (Rust)  │
    └─────────┘     └─────────┘     └─────────┘
    Reference        Python          Rust
    impl             impl            impl

    ┌─────────┐     ┌─────────┐
    │ 8gent   │     │ 8gent   │
    │ -go     │     │ -jl     │
    │ (Go)    │     │ (Julia) │
    └─────────┘     └─────────┘
    Go impl          Future
```

### Bootstrap Strategy Per Language

**Phase 1: Protocol Compliance (Week 1-2)**

Each language implementation must pass the protocol conformance suite:

```
tests/protocol/
  session-lifecycle.test.json    # Create, resume, abort, checkpoint
  tool-call-format.test.json     # JSON-RPC request/response
  policy-evaluation.test.json    # Same YAML, same decisions
  memory-schema.test.json        # SQLite tables, FTS5 queries
  streaming-output.test.json     # Token-by-token streaming
```

These tests are language-agnostic JSON fixtures. Each implementation reads them and validates behaviour.

**Phase 2: Core Agent Loop (Week 2-4)**

Minimum viable agent in each language:

| Component | Lines Target | What It Does |
|-----------|:---:|---|
| Agent loop | ~150 | Prompt -> model -> tool calls -> response cycle |
| Ollama client | ~80 | HTTP client for local model inference |
| Policy engine | ~200 | Parse YAML, evaluate conditions, decide |
| Memory store | ~150 | SQLite wrapper with episodic + semantic tables |
| Tool registry | ~100 | Register + dispatch tool calls |

**Phase 3: Factory Integration (Week 4-6)**

- Pattern digest generation (same JSON schema)
- Quarantine PR creation (gh CLI, language-agnostic)
- Security gate (same validation rules, reimplemented natively)

### Language-Specific Notes

**8gent-py (Python)**
- Runtime: Python 3.12+ with uv for package management
- TUI: Rich or Textual
- Model client: httpx for async Ollama calls
- SQLite: built-in sqlite3 module
- Target audience: data scientists, ML engineers, Python-first developers

**8gent-rs (Rust)**
- Runtime: Cargo, Rust stable
- TUI: ratatui
- Model client: reqwest with tokio async
- SQLite: rusqlite with FTS5
- Target audience: systems programmers, performance-focused engineers
- Advantage: single binary distribution, no runtime dependencies

**8gent-go (Go)**
- Runtime: Go 1.22+
- TUI: bubbletea (Charm)
- Model client: net/http with streaming
- SQLite: modernc.org/sqlite (pure Go, no CGO)
- Target audience: infrastructure engineers, DevOps, cloud-native developers
- Advantage: single binary, cross-compilation, goroutine-based concurrency

### Repository Structure

```
github.com/8gi-foundation/
  8gent-code/          # TypeScript reference (this repo)
  8gent-py/            # Python implementation
  8gent-rs/            # Rust implementation
  8gent-go/            # Go implementation
  8gi-protocol/        # Shared protocol spec + conformance tests
  8gi-setup/           # Cross-language setup script
  8gi-policies/        # Shared NemoClaw policy templates
```

---

## 8. Data Isolation

### What Stays Local (NEVER leaves the machine)

| Data | Location | Why It's Local |
|------|----------|----------------|
| Memory store | `~/.8gent/memory.db` | Contains episodic memories extracted from conversations |
| Audit log | `~/.8gent/audit.jsonl` | Full record of every policy decision |
| Session history | `~/.8gent/sessions/` | Complete conversation transcripts |
| Companion state | `~/.8gent/companion/` | Personal companion data |
| Git credentials | System keychain | Authentication tokens |
| .env files | Project directories | API keys and secrets |
| File contents | Project directories | Source code the agent reads/writes |

### What Gets Shared (opt-in only)

| Data | Destination | How It's Anonymised |
|------|-------------|-------------------|
| Weekly usage digest | 8gi-patterns.fly.dev | Random UUID member ID, +/-5% noise on counts, k>50 threshold |
| Quarantine PRs | GitHub (PodJamz org) | Code is visible but authored by the member's choice (real name or pseudonym) |
| Factory-generated code | GitHub PRs | Generated by local model, no personal context embedded |
| Aggregate circle stats | James's dashboard | Sum/avg only, no per-member breakdown |

### Anonymisation Pipeline

```
Raw Data (LOCAL)              Anonymised Digest (SHARED)
─────────────────             ────────────────────────
File: src/auth.ts             Category: "auth" (no filename)
Tool: file_write              Tool: file_write
Success: true                 Success: true
Latency: 4231ms               Latency: 4231ms +/- 5% noise
User: sarah@corp.com          MemberID: a1b2c3d4 (random UUID)
Codebase: internal-api        (stripped entirely)
Memory: "user prefers tabs"   (stripped entirely)
```

### Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│  LOCAL BOUNDARY (member's machine)                           │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Sessions │  │ Memory   │  │ Audit    │  │ Companion│   │
│  │ (full)   │  │ (full)   │  │ (full)   │  │ (full)   │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────────┘   │
│       │              │              │                         │
│       └──────────────┼──────────────┘                         │
│                      │                                        │
│              ┌───────▼───────┐                                │
│              │ Pattern       │                                │
│              │ Extractor     │  Runs locally. Strips PII.     │
│              │ (weekly)      │  Adds noise. Checks k-anon.    │
│              └───────┬───────┘                                │
│                      │                                        │
│  ════════════════════╪════════════════════════════════════    │
│    OPT-IN GATE       │  Member must explicitly enable sync    │
│  ════════════════════╪════════════════════════════════════    │
│                      │                                        │
└──────────────────────┼────────────────────────────────────────┘
                       │ HTTPS POST (anonymised digest only)
                       ▼
              ┌─────────────────┐
              │ 8GI Aggregator  │  Write-only. No auth.
              │ (Fly.io AMS)    │  No IP logging.
              └────────┬────────┘
                       │
                       ▼
              ┌─────────────────┐
              │ Aggregate Stats │  Sums and averages only.
              │ (no per-member  │  Fed into factory discovery
              │  breakdown)     │  as a signal source.
              └─────────────────┘
```

### Encryption

- Memory DB: SQLite encryption at rest (planned - using SQLCipher or similar)
- Audit log: Plain JSONL (local only, protected by OS file permissions)
- Pattern digests in transit: HTTPS/TLS 1.3 to Fly.io endpoint
- Git credentials: OS keychain (macOS Keychain / Linux libsecret)

---

## 9. Infrastructure: GitHub Org Structure

### Organisation: `PodJamz`

```
PodJamz (GitHub Org)
├── 8gent-code           # TypeScript reference (public, MIT)
├── 8gent-py             # Python implementation (public, MIT)
├── 8gent-rs             # Rust implementation (public, MIT)
├── 8gent-go             # Go implementation (public, MIT)
├── 8gi-protocol         # Shared protocol spec (public, MIT)
├── 8gi-setup            # Setup scripts (private, circle-only)
├── 8gi-policies         # Policy templates (private, circle-only)
├── 8gi-patterns         # Aggregator service (private)
└── 8gent-os             # Commercial product (private)
```

### Teams

| Team | Members | Access |
|------|---------|--------|
| `@PodJamz/core` | James | Admin on all repos |
| `@PodJamz/cto` | Rishi | Maintain on all public repos, Admin on protocol |
| `@PodJamz/circle` | All circle members | Write on public repos, Read on private |
| `@PodJamz/reviewers` | James + trusted engineers | Required reviewers for PRs |

### Branch Protection Rules (all public repos)

```
Branch: main
  - Require pull request before merging: YES
  - Required approving reviews: 1 (from @PodJamz/reviewers)
  - Dismiss stale reviews on new pushes: YES
  - Require status checks to pass:
    - security-scan
    - type-check
    - lint
    - test
    - policy-gate
  - Require branches to be up to date: YES
  - Require signed commits: RECOMMENDED (not enforced yet)
  - Restrict who can push to matching branches:
    - @PodJamz/core only (no direct push by circle members)
  - Allow force pushes: NEVER
  - Allow deletions: NO

Branch: quarantine/*
  - No protection (members push freely to their quarantine branches)
  - Auto-delete after PR merge: YES

Branch: release/*
  - Same protection as main
  - Additional: require 2 approving reviews
```

### CODEOWNERS

```
# .github/CODEOWNERS
# Default: James reviews everything
*                           @PodJamz/core

# Trusted reviewers for specific areas
packages/tools/             @PodJamz/reviewers
packages/memory/            @PodJamz/core
packages/permissions/       @PodJamz/core
packages/self-autonomy/     @PodJamz/core
scripts/                    @PodJamz/core

# CI/CD changes always need James
.github/                    @PodJamz/core
```

### Repository Settings (org-wide)

- Auto-merge: DISABLED (human approval mandatory)
- Merge button: "Create a merge commit" only (preserve provenance)
- Squash merge: DISABLED (factory commits must be traceable)
- Rebase merge: DISABLED (same reason)
- Dependabot: ENABLED (security updates only, not version bumps)
- Secret scanning: ENABLED
- Push protection: ENABLED (blocks pushes containing detected secrets)

---

## 10. Monitoring: Circle Health Without Privacy Invasion

### James's Dashboard

James tracks circle health through aggregate metrics only. He never sees individual member data, session contents, or personal patterns.

### What James Can See

```
┌──────────────────────────────────────────────────────┐
│  8GI Circle Health Dashboard                          │
│                                                       │
│  Members: 8 active / 12 total                         │
│  PRs this week: 14 (9 merged, 3 pending, 2 closed)  │
│  Factory output: 22 utilities generated               │
│  Merge rate: 64%                                      │
│                                                       │
│  ┌──────────────────────────────────────────┐         │
│  │  Activity Heatmap (aggregate)             │         │
│  │  Mon ████████░░  Tue ██████████           │         │
│  │  Wed ███████░░░  Thu ████████░░           │         │
│  │  Fri ██████░░░░  Sat ███░░░░░░           │         │
│  │  Sun ██░░░░░░░░                           │         │
│  └──────────────────────────────────────────┘         │
│                                                       │
│  Top ability categories (by collective usage):        │
│  1. async (142 uses)                                  │
│  2. string (98 uses)                                  │
│  3. data-structure (76 uses)                          │
│  4. math (45 uses)                                    │
│                                                       │
│  Model performance (aggregate):                       │
│  - Ollama qwen3.5: 93% success, 4.1s avg latency    │
│  - OpenRouter free: 89% success, 2.3s avg latency   │
│                                                       │
│  Policy blocks (aggregate count, no details):         │
│  - Secret detection: 12                               │
│  - eval() blocked: 3                                  │
│  - Force push blocked: 1                              │
└──────────────────────────────────────────────────────┘
```

### What James Cannot See

| Data | Visible to James | Why |
|------|:---:|---|
| Individual member sessions | No | Privacy - session content is personal |
| Which member triggered a policy block | No | Only aggregate block counts |
| File paths or code content | No | Stripped in anonymisation |
| Memory store contents | No | Local only, never transmitted |
| Individual usage patterns | No | Only aggregated across all members |
| Which member uses which model | No | Only aggregate model performance |
| Member's other projects | No | 8gent only reports on 8GI-related usage |

### Health Signals James Uses

**1. GitHub Activity (public, visible to all)**
- PR velocity: how many PRs per week from quarantine branches
- Review turnaround: time from PR creation to merge/close
- CI pass rate: how often PRs pass all checks on first push
- CODEOWNERS coverage: are reviews happening promptly

**2. Aggregated Pattern Digest (from opted-in members)**
- Category demand: which ability types are used most
- Failure patterns: which tool categories have high failure rates
- Model trends: which models perform best across the collective
- Session trends: are members using 8gent more or less over time

**3. Factory Pipeline Metrics (from James's own factory)**
- Generation success rate
- Security gate pass rate
- Merge rate (James's own review decisions)
- Meta-improvement trends

**4. Telegram Circle Activity (social signal)**
- Are members asking questions? (healthy)
- Are members sharing discoveries? (healthy)
- Are members going silent? (might need support)
- Are members reporting issues? (needs attention)

### Intervention Triggers (aggregate only)

| Signal | Threshold | Action |
|--------|-----------|--------|
| Weekly active members drops below 50% | < 50% active | Reach out to circle in Telegram |
| CI failure rate exceeds 30% | > 30% red PRs | Review CI config, may need relaxation |
| No PRs from circle in 7 days | 0 PRs / week | Check if setup issues, send encouragement |
| Policy block rate spikes | > 3x normal | Review if policies are too strict |
| Average merge rate drops below 50% | < 50% merged | Review factory quality or extraction heuristics |

### Privacy Commitment

James signs the same Constitution as every member. His monitoring access is:

1. **Read-only** on aggregate data
2. **No drill-down** to individual members
3. **No access** to local data on members' machines
4. **Transparent** - the aggregator code is open source, members can audit it
5. **Revocable** - any member can disable pattern sync at any time (`~/.8gent/factory-sync.json` -> `"enabled": false`)

---

## Appendix A: Setup Script Verification Checklist

After `./setup.sh` completes, the member should see:

```
8GI Setup Verification
─────────────────────────────
[PASS] Bun v1.x.x installed
[PASS] Ollama running, qwen3.5 loaded
[PASS] 8gent installed (v1.x.x)
[PASS] NemoClaw policies deployed (16 rules)
[PASS] Memory store initialized (0 entries)
[PASS] Factory sync configured (disabled by default)
[PASS] GitHub org access verified (PodJamz/circle)
[PASS] Companion bootstrapped (species: Drake)
[PASS] Smoke test passed

Your setup is ready. Welcome to 8GI.
```

## Appendix B: Emergency Procedures

**If a member's machine is compromised:**
1. Revoke their GitHub org access immediately
2. Rotate any shared secrets (Telegram bot token, etc.)
3. Review their recent PRs for malicious code
4. Re-run security scan on all quarantine branches
5. Notify circle via Telegram

**If the aggregator is breached:**
1. Take it offline (fly scale count 0)
2. Assess what was exposed (only anonymised digests)
3. Notify circle that pattern sync is paused
4. Rebuild on fresh instance after audit
5. No personal data at risk (by design)

**If a malicious PR passes CI:**
1. Revert the merge commit on main
2. Review the security gate rules that missed it
3. Add new validation rule to catch the pattern
4. Re-scan all recent merges for similar patterns
5. Post-mortem in circle Telegram

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-03-26 | Rishi (CTO) | Initial technical architecture |

---

**Document Owner:** Rishi, CTO - 8gent
**Reviewed by:** James Spalding (CAO)
**Last Updated:** 2026-03-26
**Status:** Draft - pending circle review
