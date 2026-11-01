---
name: subscription-control
description: Control monthly subscription spend with Advisor, Copilot, and Autopilot autonomy levels. Surfaces recurring expenses, forecasts costs, recommends keep-cancel-replace-downgrade actions, and executes only pre-approved cancellations behind explicit user gates.
---

# Subscription Control

Ported from `8gent-OS` `feat/subscription-control-skill-ui` (merged in PR #140 on 2026-04-28). Available to any 8gent CLI session that needs to triage recurring expenses for the user.

## Purpose

Help users reduce recurring spend by surfacing subscriptions, forecasting monthly and yearly costs, and executing approved optimization actions.

## Autonomy Levels

### 1) Advisor

- Build a recurring-expense inventory from user-provided inputs (manual entries, statements, app exports, receipts).
- Compute monthly total, yearly projection, and category totals.
- Show upcoming renewals in the next 30, 60, 90 days.
- Flag duplicate services and low-value subscriptions.
- Never execute side effects.

### 2) Copilot

- Produce keep-cancel-replace-downgrade recommendations.
- Prioritize replacements that can be handled with 8gent-native workflows.
- Generate cancellation scripts and migration checklists.
- Provide a projected savings estimate for each recommendation bundle.
- Require user confirmation before creating action plans.

### 3) Autopilot

- Execute only pre-approved actions.
- Supported actions: draft and send cancellation outreach, create reminder tasks, track evidence.
- Enforce approval gates for every irreversible step.
- Store an auditable action log with timestamp, status, and result.

## Safety Rules

- No credentials in chat output.
- No irreversible billing actions without explicit user approval.
- Validate all financial input server side.
- Rate limit ingestion and execution endpoints.
- Preserve an append-only audit trail for high-impact actions.

## Output Contract

Return structured data blocks:

- `totals`: monthly, yearly, confidence
- `renewals`: list sorted by date
- `recommendations`: keep, cancel, replace, downgrade with projected savings
- `actions`: pending approvals, executed actions, evidence refs

## CLI usage

When invoked through the 8gent CLI:

1. The agent prompts the user to pick an autonomy level, defaulting to Advisor.
2. Inventory ingestion accepts pasted statements, file uploads, or manual entries.
3. Output is structured according to the contract above and rendered through the TUI's structured-output viewer.
4. Copilot and Autopilot actions show a confirmation prompt before any side effect, with a clear summary of what will happen and how to revert.

## Governance note

This is the canonical autonomy ladder for 8gent agents that may take side-effecting actions on a user's behalf. Reuse it for new skills that touch user finances, communications, or external services. Do not invent new autonomy taxonomies without governance review (see `8gi-governance/.claude/skills/SubscriptionControl/SKILL.md`).
