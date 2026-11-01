# Build Recipe: Your First Loop

Stripe's 1,300-PRs-a-week pipeline is the endpoint, not the starting point. A first loop should be so small it barely looks like a system — a little thing that checks something on a timer. Build it small, but with the "no"-saying check and the human-review door **fully installed from the start**.

The safe order of growth: **add parallelism last**, after the checks are proven. A loop earns the right to run more agents by first demonstrating it can stop a single bad one.

## The five steps

### Step 1 — Run a `/loop`
Reruns the same task on an interval. Session-scoped, local machine, recurring tasks expire after seven days. Turn the machine off and it stops.

```
/loop 5m check the deploy   # fixed: every 5 min
/loop check the deploy      # agent paces itself
/loop                       # runs .claude/loop.md
```

This alone is not a loop — it's one line rerun. The next steps turn it into one.

### Step 2 — Add discovery (in a skill, not the schedule)
Give it a prompt to look at three things each morning and list what's worth handling. Scheduled + auto-discovery is loop entry level. **The discovery logic must live in a skill**, because a pasted prompt rots in a cron job nobody updates, while a skill can be reused and maintained.

```markdown
# .claude/skills/morning-triage/SKILL.md
NAME: morning-triage
WHEN: invoked each morning by automation.
READ:
- CI runs that failed since yesterday
- issues opened in the last 24h
- commits merged since the last run
JUDGE: for each item, is it worth acting on? Skip noise.
OUTPUT: write findings + status to ./state/triage.md (one row per finding).
```

### Step 3 — Add a state file (persistence)
Don't leave results in the chat window. Write every finding and how far it's handled into a markdown file or a Linear board. The agent forgets; the repo does not.

```
# ./state/triage.md (the loop's memory)
| finding         | source   | status   |
|-----------------|----------|----------|
| auth test flaky | CI #4821 | fixing   |
| null deref      | issue 92 | PR open  |
| stale dep       | commit a3| inbox    |
```

### Step 4 — Add an evaluator (the most critical, most skipped step)
`/goal` runs until a condition is met, with a **different model** judging whether it holds. See `generator-evaluator.md` for how to make the evaluator actually skeptical.

```
/goal all tests in test/auth pass and the lint step is clean
```

### Step 5 — Add worktrees for parallelism (last)
Use `--worktree` (or `-w`) so each background agent gets an independent working directory and they don't step on each other.

```
claude --worktree fix/auth-test "draft the fix"
claude --worktree fix/null-deref "draft the fix"
```

## First-loop checklist

The first two decide whether the loop can run; the last four decide whether it gets into trouble once it does. Beginners ship with only the first two and get a loop nobody watches and nobody can stop, nodding at itself.

| Element | Ask yourself |
|---|---|
| Discovery source | What does it read on a timer? (CI / issues / commits / inbox) |
| State file | Which disk file holds the cross-round memory? |
| Evaluator | Is there an independent check that can say "no"? |
| Isolation | Does each parallel agent get its own worktree? |
| Token cap | Did you set a spending ceiling? Who stops it if it runs off? |
| Human review | Which step pauses for a human, rather than auto-ing all the way through? |

## A complete first loop, annotated

Small enough to read in one sitting; contains every organ a real loop needs, scaled down.

```yaml
# 1. SCHEDULING — a real trigger (.github/workflows/triage.yml)
on:
  schedule:
    - cron: '0 6 * * *'        # 06:00 daily, cloud (runs with machine off)
```
```bash
# 2. DISCOVERY — a skill, not a wall of text
run: claude --skill morning-triage

# 3. PERSISTENCE — the skill writes ./state/triage.md and commits it back

# 4. HANDOFF — one worktree per finding
for finding in $(parse ./state/triage.md); do
  claude --worktree "fix/$finding" \
    --goal "tests pass and lint is clean" \
    "draft a fix for $finding"
done

# 5. VERIFICATION — /goal's stop check runs after each turn;
#    a second reviewer agent picks holes (fresh model)

# 6. HUMAN REVIEW — the open door:
#    PRs are opened, never auto-merged; anything uncertain lands in ./inbox/
```

A loop with all six, even tiny, is a real loop. Missing any one, it's one of the five failure modes wearing a disguise.

## An annotated triage skill (the discovery move, fuller)

Five of the six headings map to the five moves; the sixth — **Stop** — is where the builder writes the boundary the loop cannot infer. The loop faithfully does everything the skill says and nothing it omits, so "Stop" is not boilerplate: it is the single place the engineer's intent about where to keep control is made permanent. Leave it out and the loop merges with confidence it has not earned.

```markdown
# .claude/skills/morning-triage/SKILL.md
---
name: morning-triage
trigger: invoked by daily automation
---
## Read (the DISCOVERY inputs)
- CI runs failed since the last run
- issues opened in the last 24 hours
- commits merged since yesterday
- the previous ./state/triage.md

## Judge (the part that sets the ceiling)
For each candidate: actionable now or noise? blocks a release? → priority.
Already tracked? → skip. Keep only what's worth a worktree today.

## Write (the PERSISTENCE output)
Append to ./state/triage.md: | finding | source | priority | status |
Commit the file so tomorrow can read it.

## Hand off (prepare the HANDOFF)
For each kept finding, emit: worktree=fix/<slug> goal=<stop-condition>

## Stop (the boundary you keep for yourself)
Never merge. Never delete. Anything you are less than confident about
goes to ./inbox/ for a human, not into a PR.
```
