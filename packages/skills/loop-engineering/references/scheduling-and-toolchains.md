# Scheduling & Toolchains

## Where should the loop run? Local vs cloud

The choice isn't taste — it follows mechanically from one question: **is the loop's work glued to the local machine, or can it leave?**

| | Cloud | Desktop | `/loop` |
|---|---|---|---|
| Where it runs | cloud machine | machine | machine |
| Machine on? | no | yes | yes |
| Session open? | no | no | yes |
| Min. interval | 1 h | 1 min | 1 min |
| See local files? | no | yes | yes |

**Two scenarios make the rule clear:**
- A loop that must check a *local dev server every minute* can only run locally — the cloud can't see a process on your laptop, and the cloud interval can't drop below an hour.
- A loop that should *scan open issues at 3 a.m. and open PRs* should never be tied to a laptop — laptops get their lids closed, lose power, and get carried out the door. Use a cloud schedule or CI schedule trigger.

**The distortion to avoid:** treating local rerun as the whole of "running while you sleep." Local rerun means "run a few extra rounds while I'm here." Cloud scheduling means "run even when I'm not." Conflating them is how people end up disappointed when they close the lid and the "autonomous" loop quietly stops.

A mature loop often uses **both** — local for the tight inner checks, cloud for the overnight sweep. No single scheduler does it all.

## Same capability, two toolchains

Loop engineering is a set of capabilities, not a product. Codex offers the same organs under different names, and a connector written for one side can often move to the other unchanged. The question to ask is whether all six organs are present, not which brand of command provides them.

| Capability | Claude Code | Codex |
|---|---|---|
| Scheduling | `/loop` worker | Automations tab |
| Run until met | `/goal` | automation rerun + judge |
| Parallel isolation | `--worktree` | background worktree |
| Sub-agents | `.claude/agents/` | `.codex/agents/` |
| External connection | MCP + plugins | MCP connector |
| Explicit skill | `SKILL.md` | `$skill-name` |
| Machine-off run | Cloud Routines | cloud (planned) |

## The six parts (organs) of any loop

| Part | What it is | Realizes move |
|---|---|---|
| Automations | Runs off a schedule / trigger | Scheduling |
| Worktrees | Isolated dirs for parallel agents | Handoff |
| Skills | Permanent knowledge (SKILL.md); pays off *intent debt* — the recurring cost of re-explaining the project | Discovery |
| Connectors | MCP hookup to external systems; decides the loop's radius of vision | Persistence / Discovery |
| Sub-agents | Generator separated from judge | Verification |
| Memory | Persistent state on disk, surviving any single conversation | Persistence |

Memory is not context: context is what the agent sees this round and is flushed on refresh; memory persists across rounds and days.

## Stripe's Minions: the enterprise endpoint

Worth studying as where this path leads (1,300+ PRs merged per week, none written by hand), and for one counterintuitive lesson: **reliability comes from the quality of the constraints, not the size of the model.** Minions is a fork of the open-source tool Goose, not a stronger model.

Its skeleton: a light trigger (@ the bot in Slack, or an emoji reaction) → a *deterministic* orchestrator assembles context first (scanning links, pulling Jira, Sourcegraph + MCP to locate code) → only then does the LLM write code → a hard-coded gate runs the linter and the agent cannot skip it → the agent fixes lint → a hard-coded commit step → human review at the end.

The line to draw: **anything deterministic logic can solve never goes to a probabilistic model.** Letting the LLM find its own context is the least controllable part, so that work — whose rules can be hard-coded — is taken out of the model's hands. Where you draw that line decides whether the loop is reliable. The humans didn't leave; they changed desks, from writing to reviewing.
