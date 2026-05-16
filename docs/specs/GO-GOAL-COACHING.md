# /goal Goal Coaching

Status: draft v1
Owner: 8PO (Samantha)
Cross-reference: epic #2605, sub-issue #2607

The /goal loop only works if the goal has a verifiable outcome. Most users state goals vaguely on the first try. This spec defines how the agent turns a vague goal into a specific one in a single round trip, without rejecting the user.

This is the difference between an agent that feels like a teammate and one that feels like a form.

---

## The rule

If the user's goal lacks a verifiable outcome, the agent proposes one back, in one sentence, and offers one-tap accept. The user either confirms or refines in plain English. Never a form. Never a multi-step wizard. Never "please rephrase".

## What "verifiable outcome" means

A verifiable outcome is something the judge can check by execution, not by reading the agent's summary. If we can write a shell command or test assertion that returns yes/no, it's verifiable. If we have to read prose and decide if it sounds done, it's not.

Examples of verifiable: a file exists at a path, a test passes, a process is no longer running, a CSV has zero duplicate rows.

Examples of NOT verifiable: "the code is cleaner", "the docs are better", "the email feels warm".

## The coaching round-trip

1. User types goal.
2. Agent classifies in <500ms (local heuristic, no LLM): does the goal name a concrete artifact, location, or measurable end-state?
3. If yes: start the run.
4. If no: the agent emits exactly one coaching line:
   ```
   I'll consider this done when [X]. Confirm or refine?
   ```
5. User has two choices, one tap each:
   - `Enter` / tap accept → start the run with the coached goal
   - Any text → the agent re-coaches with the user's refinement folded in, ONCE more, then starts the run regardless (no third round)
6. After two coaching rounds maximum, the agent always starts. Better to start with an imperfect goal than to stall the user.

## Hard rules

- The agent NEVER rejects a goal. The worst case is a starting goal the agent thinks is loose.
- The agent NEVER asks more than two questions before starting. Two is the cap.
- The coaching line is one sentence. No bullet lists. No "I need to clarify a few things".
- The coached goal is the one that gets stored on the run record. The original goal is also stored under `goal_raw` for audit.
- If the user rejects the coached goal twice without offering a refinement, the agent runs the original raw goal anyway, marks the run as `coaching_skipped=true`, and lets the judge handle the ambiguity at evaluation time.

## What the agent looks for

A goal is treated as verifiable if it contains at least one of:

- a file path or directory (`~/Downloads`, `/tmp/x.csv`)
- a concrete count or threshold ("under 120 words", "exactly 5 entries")
- a named tool/file/test ("bun test", "package.json")
- an action verb that produces a checkable artifact ("write", "save", "create", "delete", "merge")
- a named recipient or audience for a comms task ("email to Lisa")

If none of these are present, the agent coaches.

---

## Five worked examples

### Example 1

**User says:** "Clean up my Downloads folder."

**Agent coaches:** `I'll consider this done when files older than 30 days are deleted and the rest grouped into subfolders by extension, with a log at /tmp/downloads-clean.log. Confirm or refine?`

**User taps accept.** Run starts with the coached goal.

### Example 2

**User says:** "Make the sum function not break on empty arrays."

**Agent coaches:** `I'll consider this done when sum([]) returns 0 and a new test in sum.test.ts covers the empty case and bun test passes. Confirm or refine?`

**User refines:** "Yes but use vitest not bun test."

**Agent coaches once more:** `I'll consider this done when sum([]) returns 0 and a new vitest test covers the empty case and the suite passes. Confirm or refine?`

**User taps accept.** Run starts.

### Example 3

**User says:** "Help me organize my notes."

**Agent coaches:** `I'll consider this done when files in ~/Documents/notes are grouped into subfolders by topic, with a /tmp/notes-organized.md summarizing what moved where. Confirm or refine?`

**User refines:** "Group by date not topic, last 90 days only."

**Agent coaches once more:** `I'll consider this done when ~/Documents/notes files from the last 90 days are grouped into subfolders by month (YYYY-MM), with a /tmp/notes-organized.md summary. Confirm or refine?`

**User taps accept.** Run starts.

### Example 4

**User says:** "Write the changelog for the next release."

**Agent coaches:** `I'll consider this done when /tmp/changelog-next.md exists with Features, Fixes, and Chores sections from the last 20 commits, each line referencing a commit hash. Confirm or refine?`

**User taps accept.** Run starts.

### Example 5

**User says:** "Make this codebase better."

**Agent coaches:** `That goal is too broad for one run. I'll consider this done when I've added unit tests to one untested file in packages/ and bun test passes. Confirm or refine?`

**User says nothing for 30 seconds, then types:** "fine just do it"

**Agent runs the coached goal** (the user accepted by not refining). Run starts.

---

## Edge cases

- **Multi-part goals** ("clean Downloads AND draft an email to Lisa"): agent coaches into two sub-goals, runs them sequentially, emits one combined receipt at the end.
- **Goals that depend on missing context** ("update the deck for tomorrow"): the agent asks ONE clarifying question first (one path: "which deck?"), then coaches the verifiable outcome. The clarifying question does NOT count as a coaching round.
- **Goals that are already verifiable** ("write hello world to /tmp/hi.txt"): no coaching. Run immediately.
- **Hostile or unsafe goals**: not handled here. The capability budget + deny-list (8SO, separate sub-issue) blocks them before coaching.

## Telemetry

Each coaching event logs to the run ledger as `event: goal.coached` with `{round: 1|2, accepted: bool, raw_goal, coached_goal}`. This lets us measure week 1 whether coaching is converging users to verifiable goals or whether the heuristic is too aggressive.

Target: <30% of runs trigger coaching round 2. If higher, the heuristic in step 2 is rejecting too many goals that should have started immediately.

---

## Open questions for the boardroom

1. Should coaching ever fire after a `/goal resume`? (Default proposal: no, the resumed run already has a coached goal.)
2. If the agent's coaching proposal contains an unsafe action (writes to /etc, deletes the homedir), does 8SO's deny-list redact the proposal or block it? (Default proposal: block the proposal, ask the user for a different scope.)
3. Should the coached goal be saved as a "template" the user can replay later via `/goal --like <run-id>`? (Default proposal: yes, it's a one-line addition and worth the muscle memory.)
