# Security regression suite

Each file pins one security finding so it cannot silently regress. Every test
here has been run against the unfixed code, or a deliberately broken copy, and
seen to fail. A test that has never been red is not evidence of anything.

```bash
bun run test:security        # or: bun test tests/security
```

No network, no models, no API keys. The memory tests replace the Ollama
embedding probe with the built-in null provider; the decide tests use stub
deciders, the offline `MockBackend`, and a `fetch` that refuses every call.

## What each file pins

| File | Finding | PR | Tests |
|------|---------|----|-------|
| `grader-env.test.ts` | The benchmark grader passed `...process.env` to `bun test` on model-written code, so every key 8gent holds was readable by it. Drives the real `gradeExecution()` and `gradeMultiFileExecution()` with a fixture that dumps its own environment; a random `EIGHT_SEC_CANARY` and planted `*_KEY`/`*_TOKEN`/`*_SECRET`/`*_PASSWORD` vars must not cross, and no secret-shaped name may appear. Static: no spawn in `benchmarks/autoresearch` spreads `process.env`, and every spawn in the grader passes `childEnv()`. | 2989 | 4 |
| `memory-admission.test.ts` | Nothing gated what could be stored as memory. Pins both write paths (`MemoryStore.write()` and the session layer of `MemoryManager.remember()`): an AWS example key is redacted, "ignore all previous instructions" is refused with `MemoryTrustError`, the same instruction interleaved with invisible Unicode tag characters is still refused, an instruction written wholly in tag characters does not survive into storage, and an ordinary fact is stored unchanged. | 2988 | 8 |
| `recall-fail-closed.test.ts` | `SemanticRecall` returned `[]` on any error, indistinguishable from "no memories". A closed or schema-broken store must throw `MemoryRecallError` (also through `recallAsText()`); a healthy empty store must return `[]`. | 2984 | 4 |
| `decide-guard.test.ts` | `bashGuard()` must fail closed: block when the decider throws, returns nothing, NaN, +/-Infinity, a value outside [0, 1] or a non-number, and when no backend is reachable. Allow only for a valid low probability. The guard is James's code (PR 2995); it is here because it is the same fail-closed rule as PR 2984. | 2995 | 17 |
| `install-no-network.test.ts` | `postinstall.js` ran `npx bmad-method init`, fetching and executing an unpinned package on every install. Static scan of every root lifecycle script, the files they run, the bridge `build.sh` postinstall shells out to, and its `Package.swift` (no remote dependencies). Comments are stripped, since the postinstall header quotes the removed command as an opt-in hint. | 2969 | 4 |
| `workflow-injection.test.ts` | `auto-release.yml` and `version-bump-on-main.yml` (both `contents: write`) expanded the PR title, labels, author and head commit message with `${{ }}` inside `run:`, so crafted text ran as shell. Static: no `${{ }}` in any `run:` block of the two files, every `uses:` pinned to a commit SHA. Runtime: the real step scripts run as the runner runs them (expressions substituted as text, `bash -eo pipefail`) with `"; touch`, `$(...)` and backtick payloads; no marker file may appear and the bump level must still be read from the text. | #3214 | 7 |
| `home-resolver.test.ts` | Direct `os.homedir()` cannot be sandboxed on Windows; `resolveHome()` in `packages/core/home.ts` is the one resolver. See the note below. | 2972, 2981 | 5 |

### The home resolver is a ratchet, not a zero

On `origin/main` at `0611301d`, 153 runtime files (230 calls) still call
`homedir()` directly. Migrating them is #2971 step 2, which has not happened.
So the test pins three things: the two sites Artale migrated in PR 2981
(`packages/computer/bridge.ts`, the debugger `system-health` route) never go
back; no file outside `fixtures/homedir-baseline.ts` may call `homedir()`; no
baseline file may gain calls. A stale baseline entry fails too, so the list
only shrinks and must be edited when a file is migrated. The baseline is
backlog, not an allowlist of legitimate uses. The one legitimate direct call is
`packages/core/home.ts` itself (the resolver's last fallback).

## Shown able to fail

"Pre-fix" means a detached checkout of the parent of the fix's merge commit.
"Mutation" means one deliberate break applied to current main in a scratch
worktree, the test run, the file restored, and the test run again.

| Test file | Red on | Result when red | Green on |
|-----------|--------|-----------------|----------|
| grader-env | pre-fix `8546c585` (parent of 2989 merge) | 4/4 fail; the child received the canary value | main `0611301d` |
| grader-env | mutation: `childEnv()` spreads `process.env` again | 2 fail (both runtime probes) | restored |
| memory-admission | pre-fix `e6fc15ed` (parent of 2988 merge) | 6 fail; the 2 no-false-refusal controls pass, as they should | main |
| memory-admission | mutation: session-layer `admitText()` removed, store gate kept | 2 fail (session tests only) | restored |
| memory-admission | mutation: instruction check runs before `sanitize()` | 2 fail (tag-interleaved tests) | restored |
| recall-fail-closed | pre-fix `297bef8d` (parent of 2984 merge) | 3 fail; the healthy-empty control passes | main |
| recall-fail-closed | mutation: catch returns `[]` again | 3 fail | restored |
| decide-guard | mutation: finite/range check removed | 3 fail (NaN, -Infinity, -0.1) | restored |
| decide-guard | mutation: decider error returns "allow" | 3 fail (throw, both unavailable-backend tests) | restored |
| install-no-network | pre-fix `27594d2f` (parent of 2969 merge) | 2 fail; `npx` found in postinstall | main |
| install-no-network | mutation: postinstall regains an `npx` call | 2 fail | restored |
| workflow-injection | main `297e56b8` (unfixed workflows) | 7/7 fail; every payload created its marker file | fix branch |
| workflow-injection | mutation: `MSG="${{ github.event.head_commit.message }}"` back in version-bump | 2 fail (static + runtime) | restored |
| home-resolver | pre-fix `8c57a585` (parent of 2981 merge) | 2 fail; bridge.ts and system-health route call `homedir()` | main |
| home-resolver | mutation: bridge.ts back to `os.homedir()` | 2 fail | restored |
| home-resolver | mutation: a new runtime file calls `homedir()` | 1 fail | restored |

decide-guard has no pre-fix run: PR 2995 added the module, so before it the
import fails, which proves nothing. The mutations are the evidence.

## Not covered

- Artale's forge branch `fix/grader-fail-closed` (commit 8fdd980a, "refuse to
  grade when no execution boundary is available") is not on main, so there is
  nothing to pin yet. Add a test here when it lands.
- The `network_request` gate firing only for nine named tools (a spawned child
  is not one of them) was reported in the PR 2989 commit message but not fixed.

---

For Artale (8SO), whose findings these are. He taught us that the presence of
a thing is not evidence that it works, so each of these was made to fail first.
