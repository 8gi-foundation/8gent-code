# Vessel Abilities (1-4)

The first four abilities that run on the Eight vessel without a sandbox.

## Environment Variables

All persistent paths respect `EIGHT_DATA_DIR`. When unset, defaults to `~/.8gent/`.

On Fly.io the volume is mounted at `/root/.8gent/` and `HOME=/root`, so the default works. Setting `EIGHT_DATA_DIR=/data` would redirect all storage to a different mount point.

`EIGHT_TURN_TIMEOUT_MS` bounds a single provider attempt inside the agent's failover loop by wall-clock time. On the native tool path (a non-streamed generate(), which gives no progress signal) it defaults to `300000` (5 minutes). On the text-tool path a step is judged by progress instead (see `EIGHT_STREAM_IDLE_MS`), so there the wall clock is only a safety net and defaults to `1200000` (20 minutes); setting this variable makes its value the ceiling on both paths. On timeout the attempt is aborted and treated as a provider failure, so the chain fails over and an exhausted chain returns a clean error instead of hanging the turn (and any WebSocket caller) until the 30-minute session watchdog. Lower it for fast cloud-only setups that want quicker failover; raise it when a local model legitimately needs longer than the ceiling for one answer. Values of `0`, negative, or non-numeric fall back to the default; a 1000 ms floor is enforced so an attempt is never effectively instant.

`EIGHT_STREAM_IDLE_MS` is on by default at `300000` (5 minutes). A model step on the text-tool path (`ollama`, `lmstudio` and `llama-server` by default, or any provider forced onto it with `EIGHT_TEXT_TOOLS=1`) is streamed and judged by progress instead of total time: the idle timer is re-armed on every chunk of the reply, reasoning tokens included, so a thinking model that needs ten minutes before its first answer is never cut off while it is still writing (#3657), and a connection that goes quiet for longer than the gap fails with a turn-timeout error that names this variable, then fails over. Steps on the native tool path are unaffected and keep the 5-minute wall clock. Set `0` (or `off`) to turn the gap off and judge by total time only, as before #3553; a 1000 ms floor is enforced; a non-numeric value falls back to the default, never to off. With the gap on, the default per-step wall-clock ceiling is 20 minutes (`1200000`) instead of 5, unless `EIGHT_TURN_TIMEOUT_MS` is set, in which case that value is the ceiling. The `max_tokens` cap and the 30-minute session watchdog still apply. A local runtime such as Ollama sends nothing, not even headers, until it has prefilled the whole prompt, so prompt prefill is not counted as silence (#3643): until the first byte of the reply arrives the step waits up to a first-token budget instead, the idle gap plus the prompt's estimated prefill time at a conservative 50 tokens per second (about 4 characters per token), never more than the per-step ceiling. A short prompt on a dead endpoint still fails over after about one gap; a long document gets minutes to prefill. `EIGHT_FIRST_TOKEN_MS` (milliseconds, 1000 ms floor) replaces that estimate with a fixed budget. A box where prefill is quick can lower the gap (for example `60000`) for faster failover. The gap counts bytes, so a runtime must stream its reasoning deltas for thinking time to count as progress; one that withholds thinking until the answer is judged silent while it thinks. A server that drips a byte just inside the idle window is held to the wall-clock ceiling (20 minutes by default), which the 30-minute session watchdog bounds. Both variables are clamped to 2147483647 ms (the largest timer delay), so `1e12` means about 24.8 days rather than overflowing to an instant timeout; a streamed reply is also capped at 8 MB, and one line at 1 MB, failing with a clear error.

---

## 1. Memory (`packages/memory/`)

**What it does:** SQLite + FTS5 full-text search with optional vector cosine similarity. Stores episodic, semantic, procedural, and core memories. Knowledge graph with entities and relationships.

**Storage paths:**
- Global store: `$EIGHT_DATA_DIR/memory/memory.db`
- Project store: `<workingDirectory>/.8gent/memory/memory.db`

**Registration:** Registered as `remember` and `recall` tools in `packages/eight/tools.ts`. The `MemoryManager` singleton is accessed via `getMemoryManager()`.

**Cloud readiness:**
- SQLite WAL mode for concurrent reads
- Global store path uses `EIGHT_DATA_DIR` env var
- Data persists on the Fly.io volume across container restarts

**How to test:**
```
1. Send: "Remember that James prefers dark mode"
2. Restart the vessel (fly machine restart)
3. Send: "What does James prefer?"
4. Verify the response mentions dark mode
```

---

## 2. Browser (`packages/tools/browser/`)

**What it does:** HTTP fetch + DuckDuckGo HTML scraping. No headless browser needed. SHA-256 keyed disk cache with 1-hour TTL and 100MB cap.

**Storage paths:**
- Cache: `$EIGHT_DATA_DIR/browser-cache/`

**Registration:** Registered as `web_search` and `web_fetch` tools in `packages/eight/tools.ts`. Uses `packages/tools/web.ts` (cheerio + JSDOM Readability) as the primary implementation, with `packages/tools/browser/` as a lightweight alternative.

**Cloud readiness:**
- Pure HTTP fetch, works in any container
- Cache directory uses `EIGHT_DATA_DIR` env var
- Cache is non-critical (ephemeral is fine, persistent is better)

**How to test:**
```
1. Send: "Search the web for 'Fly.io Dublin data center'"
2. Verify results come back with titles and URLs
3. Send: "Fetch the content from https://fly.io/docs/"
4. Verify readable text is returned
```

---

## 3. Policy (`packages/permissions/`)

**What it does:** YAML-driven policy evaluation for agent actions. 11 default rules covering secrets, destructive commands, git protections, network safety, and file access.

**Default rules (from `default-policies.yaml`):**
1. `no-secrets-in-files` - block writing API_KEY/SECRET/PASSWORD/TOKEN/PRIVATE_KEY
2. `no-env-file-leak` - require approval for .env writes
3. `no-rm-rf-root` - block recursive delete from root
4. `no-fork-bomb` - block fork bomb patterns
5. `no-pipe-to-shell` - require approval for `| sh` / `| bash`
6. `no-sudo-destructive` - block `sudo rm` / `sudo mkfs` / `sudo dd`
7. `protected-branches-push` - require approval to push to main/master/production/prod
8. `no-force-push-main` - block force push to main
9. `no-hard-reset` - require approval for `git reset --hard`
10. `no-exfil-domains` - block requests to pastebin/ngrok/requestbin
11. `no-delete-config` - require approval to delete package.json/tsconfig/CLAUDE.md

**Storage paths:**
- Default policies: bundled at `packages/permissions/default-policies.yaml`
- User overrides: `$EIGHT_DATA_DIR/policies.yaml`
- Permission config: `$EIGHT_DATA_DIR/permissions.json`

**Registration:** The `PermissionManager` is used in `packages/eight/tools.ts` for command execution gating. The `PolicyEngine` is available via `evaluatePolicy()`, `checkCommand()`, `checkFileWrite()`, `checkGitPush()`.

**Cloud readiness:**
- Default policies ship with the code (no external file needed)
- User overrides path uses `EIGHT_DATA_DIR` env var
- In headless/daemon mode, auto-approves most actions except merge/push to main

**How to test:**
```
1. Send: "Run the command: rm -rf /"
2. Verify it's blocked by policy
3. Send: "Run the command: git push --force origin main"
4. Verify it's blocked
5. Send: "Run the command: ls -la"
6. Verify it's allowed
```

---

## 4. Evolution (`packages/self-autonomy/`)

**What it does:** Post-session reflection with Bayesian skill confidence tracking. Records session reflections (tools used, errors, patterns, skills learned) and maintains a learned skills database.

**Storage paths:**
- Evolution DB: `$EIGHT_DATA_DIR/evolution/evolution.db`

**Tables:**
- `reflections` - session summaries with success rates
- `learned_skills` - trigger/action pairs with confidence scores (Bayesian updates)

**Registration:** The `reflect()` function is exported from `packages/self-autonomy/reflection.ts`. `learnSkill()`, `getRelevantSkills()`, `reinforceSkill()`, `buildSkillsContext()` are exported from `packages/self-autonomy/learned-skills.ts`. The `SelfAutonomy` class provides git-aware task management and self-healing.

**Cloud readiness:**
- SQLite database path uses `EIGHT_DATA_DIR` env var
- Reflections persist across container restarts
- Bayesian confidence scores accumulate over sessions

**How to test:**
```
1. Have a multi-tool conversation (e.g., "Search for X then remember Y")
2. Check evolution DB: the session reflection should be recorded
3. Restart vessel
4. Verify learned skills persist: send "What skills have you learned?"
```

---

## Architecture

```
EIGHT_DATA_DIR (default: ~/.8gent/)
  +-- daemon.log
  +-- daemon-state.json
  +-- config.json
  +-- permissions.json
  +-- policies.yaml (user overrides)
  +-- memory/
  |   +-- memory.db (global SQLite + FTS5)
  |   +-- global.jsonl (v1 compat)
  +-- browser-cache/
  |   +-- <sha256>.json (1h TTL, 100MB cap)
  +-- evolution/
      +-- evolution.db (reflections + learned skills)
```
