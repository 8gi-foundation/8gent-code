# Failure Modes: Five Ways a Loop Goes Wrong

Each anti-pattern is exactly one of the five moves skipped or done badly. Diagnose by symptom; fix by installing the missing move. These cluster — a loop missing one check is usually careless about the others — because the disciplined builder installs all five moves while the hasty one installs only discovery and handoff (the two that produce *visible output*) and skips the three that produce *safety*.

## The Nodding Loop — verification skipped
**The most common failure.** The same agent writes the code and declares it good. Every turn produces self-approved output; the loop accumulates plausible-looking mistakes at machine speed.

**Symptom:** a loop that has never once said "no" to itself across hundreds of turns — a statistical impossibility for any real workload, and therefore proof that no real check exists.

**Fix:** the generator/evaluator split (see `generator-evaluator.md`).

## The Amnesiac Loop — persistence skipped
The loop discovers good work, does it, then forgets, because the result lived only in a flushed context window. Next turn rediscovers the same work — or redoes it and conflicts with the first attempt.

**Symptom:** no cumulative progress; each morning it starts from the same place.

**Fix:** a state file on disk. The agent forgets; the repo does not.

## The Manual Loop — scheduling skipped
Four good moves but no automation. It works impressively the day it's built and silently stops the day attention wanders.

**Symptom:** the loop's last run was the day it was demoed.

**Fix:** a real trigger — a timer or event — that doesn't depend on the human remembering.

## The Blind Loop — discovery skipped
The human still hands the loop its work each morning ("fix these three bugs"), so the loop automated the *doing* but not the *finding* — and choosing what to work on is often the expensive part.

**Symptom:** a human still spending their morning deciding what the loop should do.

**Fix:** teach discovery into a skill so the loop surfaces its own work.

## The Tangled Loop — handoff skipped
Several agents run in parallel but all change the same working directory, so edits collide and the merge is unsalvageable.

**Symptom:** appears only under parallelism — a single-agent loop looks fine; the problem shows the first morning five agents run at once.

**Fix:** one isolated worktree per task.

---

## The four silent costs

None sounds an alarm while the loop runs. They are a single failure wearing four faces, and they reinforce each other: unverified output erodes understanding → invites surrender → lets the loop run longer and spend more → produces more unverified output.

| Cost | What it is | Guard |
|---|---|---|
| **Verification debt** | Output piling up in the gap between "runs" and "right," where tests don't cover | An independent evaluator (a different agent from the one doing the work) |
| **Comprehension rot** | The gap between what exists and what you understand, as the loop ships code you didn't write | Read a representative sample daily; force yourself to explain a few changes |
| **Cognitive surrender** | Ceasing to have an opinion and just taking what it hands back ("no longer want to bother") | One line: the loop can execute, but it cannot decide |
| **Token blowout** | Helpers, retries, round after round — one bug spins idle all night into an unfamiliar bill | Hard caps set before shipping: per-run, daily, max retries |

The most dangerous thing about loops is the same as the most powerful: one person does a team's work — but a team argues with itself, while one person plus a pile of loops becomes an echo chamber where no one argues. The guard against all four costs is the same: keep a human capable of saying "no," and install a check the human doesn't have to be awake to run.
