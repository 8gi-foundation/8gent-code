# Quarantine Spec - Linear Agent Skills Pattern

**Source:** Linear changelog 2026-03-24, linear.app/next
**Status:** Pattern extraction only - no code adoption
**Date:** 2026-03-25

---

## What Linear Announced

Linear declared "Issue tracking is dead" on March 24, 2026. Their thesis: traditional issue tracking was built for a handoff model (PM scopes, engineer picks up later) that created overhead which "became the work" itself. They are repositioning as "the shared product system that turns context into execution."

Over 75% of Linear enterprise workspaces now use coding agents. Agent-authored work grew 5x in three months.

### Linear Agent

A native AI agent embedded in Linear that understands roadmap, issues, and code. Available via:
- Desktop app (Cmd+J)
- Mobile app
- Slack (@Linear mention)
- Microsoft Teams
- Inline comments

The agent can synthesize context, make recommendations, and take action - creating projects, issues, and documents from conversations and feedback.

### Linear Skills

Skills are reusable, saved workflows. Core pattern:

1. User has a productive conversation with the agent
2. User says "save this as a skill"
3. Linear saves the conversation pattern as a named, reusable workflow
4. Skills can be triggered three ways:
   - Manual: slash command (/) in any chat
   - Menu: skills picker in any chat
   - Auto: Linear detects when a skill is applicable and runs it

Example skills: "Split into sub-issues", "Catch up on project", "Draft issues from meeting notes"

This is essentially **workflow recording + replay with AI interpolation**.

### Automations (Business/Enterprise)

Trigger agent workflows automatically when issues enter triage. The system adds context, refines, synthesizes, or acts on incoming work. Example: customer context automation adds impact summaries to triaged issues.

### Code Intelligence (Coming Soon)

Extends agent understanding to the codebase. Non-technical users can ask about feature implementation, system ownership, recent changes. Enables code-aware specs and diagnosis.

---

## Pattern Extraction

### Core Pattern: Skills = Named Reusable Agent Workflows

```
CONCEPT EXTRACTION (not code adoption)
- Core pattern: Save a successful agent interaction as a named, triggerable workflow
- Can we rebuild it in <200 lines? Yes
- Does it solve a problem we actually have today? Yes - Eight has no way to save and replay successful task patterns
- Smallest proof: A skill registry that stores task templates and auto-matches them to new requests
```

### What matters for 8gent:

1. **Skill = template + trigger + executor pattern**
   - Template: what the skill does (prompt, steps, tool calls)
   - Trigger: when it activates (manual command, pattern match, triage event)
   - Executor: how it runs (agent loop with the template as system context)

2. **Skills compound organizational learning**
   - Every successful interaction can become a reusable pattern
   - This maps directly to Eight's self-autonomy/reflection system
   - Our `packages/self-autonomy/reflection.ts` already captures lessons - skills are the actionable version

3. **Triage automation = proactive pattern matching**
   - When new work arrives, match it against known skills
   - Our `packages/proactive/` already has opportunity scanning and capability matching
   - The gap: we scan external sources but don't auto-triage our own backlog

---

## Mapping to 8gent Architecture

| Linear Concept | 8gent Equivalent | Gap |
|---------------|-------------------|-----|
| Skills | No direct equivalent | Need skill registry in `packages/proactive/` |
| Agent chat | Eight agent loop (`packages/eight/agent.ts`) | Already exists |
| Automations | `packages/proactive/opportunity-scanner.ts` | Scans external, not internal backlog |
| Code Intelligence | `packages/ast-index/` | Already exists, needs wiring |
| Triage | No equivalent | Need auto-triage on incoming tasks |
| Skill auto-detection | `packages/proactive/capability-matcher.ts` | Matches capabilities, not workflows |

### Where the prototype fits:

`packages/proactive/agent-skills.ts` - a skill registry that:
- Stores named task templates (the "skill")
- Matches incoming tasks against known skills
- Returns the best skill match with its template for the agent to execute
- Allows saving new skills from successful task completions

This bridges our existing `work-tracker.ts` (tracks opportunities) with a new layer that tracks *how* to handle recurring work patterns.

---

## What We Are NOT Doing

- Not building a Linear clone or issue tracker UI
- Not adding Slack/Teams integrations
- Not building "Code Intelligence" (we have ast-index)
- Not building enterprise triage automations
- Not adopting Linear's data model or API

## Success Metric

A working skill registry under 200 lines that Eight can use to:
1. Save a task pattern as a named skill
2. Match new tasks against saved skills
3. Return the matching skill's template for execution

---

## Sources

- [Linear Changelog - Introducing Linear Agent](https://linear.app/changelog/2026-03-24-introducing-linear-agent)
- [Linear - Issue tracking is dead](https://linear.app/next)
