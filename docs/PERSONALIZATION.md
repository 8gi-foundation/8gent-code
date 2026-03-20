# Personalization & Developer Experience

8gent learns who you are, how you work, and what you prefer. Authenticate once, never configure again. Every session gets smarter.

---

## Table of Contents

- [Overview](#overview)
- [Smart Onboarding](#smart-onboarding)
- [Preferences Cloud Sync](#preferences-cloud-sync)
- [Adaptive System Prompt](#adaptive-system-prompt)
- [Session History & Resume](#session-history--resume)
- [Personal LoRA Training](#personal-lora-training)
- [ESC to Interrupt](#esc-to-interrupt)
- [Slash Commands Reference](#slash-commands-reference)
- [Configuration](#configuration)
- [Architecture](#architecture)

---

## Overview

8gent's personalization system is built on a simple principle: **the agent should know you better with every session**. Rather than asking you to fill out config files or tweak YAML, 8gent detects your environment, asks three focused questions, and then adapts continuously.

The personalization pipeline has four stages:

1. **Auto-detection** -- reads your git config, scans for Ollama/LM Studio models, checks `gh auth` status.
2. **Onboarding** -- a 3-question interactive flow that fills in what detection missed.
3. **Cloud sync** -- preferences travel with you across machines via Convex (after `/auth login`).
4. **Continuous learning** -- session traces are collected and quality-filtered for personal LoRA fine-tuning.

All personalization data lives in `.8gent/user.json` (local) and optionally syncs to Convex (cloud). Local data is never sent to third parties. Cloud sync is opt-in via authentication.

---

## Smart Onboarding

On first launch, 8gent runs auto-detection in parallel before asking you anything:

### Auto-Detection

| Signal | How it's detected | What it sets |
|--------|-------------------|-------------|
| Your name | `git config --global user.name` | `identity.name` |
| Your email | `git config --global user.email` | displayed in onboarding summary |
| Ollama models | `ollama list` | `integrations.ollama.models`, `preferences.model.default` |
| LM Studio models | `GET http://localhost:1234/v1/models` | `integrations.lmstudio.models` |
| GitHub auth | `gh auth status` | `integrations.github.username` |
| Preferred provider | presence of Ollama or LM Studio | `preferences.model.provider` |

All checks run via `Promise.allSettled` -- if any fail (e.g., Ollama not installed), they are silently skipped.

### The 3-Question Flow

After detection, onboarding presents what it found and asks only what it could not infer:

**Question 1 -- Identity confirmation:**

```
Good day. I'm 8gent, The Infinite Gentleman.

Here's what I detected:
  Name: James Spalding
  Email: (via git)
  GitHub: jamesspalding
  Provider: ollama
  Models: deepseek-coder-v2, qwen2.5-coder, llama3.2

Press Enter to accept, or type your preferred name:
```

**Question 2 -- Communication style:**

```
How should I communicate with you?

1. Concise & direct (just the facts)
2. Detailed & explanatory (teach me as we go)
3. Casual & friendly (we're collaborators)
4. Formal & precise (professional tone)
```

**Question 3 -- Confirmation:**

```
Excellent. All set:

- Name: James
- Style: concise
- Provider: ollama

Ready to begin? (yes/no)
```

### Re-running Onboarding

To re-run the onboarding flow at any time:

```
/onboarding
```

Aliases: `/onboard`, `/setup`, `/intro`

This resets onboarding state and walks through detection + questions again. Useful after installing new models, switching machines, or changing preferences.

### Skipping Questions

You can skip individual questions with `/skip` or skip everything with `/skip all`. Skipped areas are tracked in `understanding.areasUnclear` and 8gent may ask follow-up clarification questions later (after 7 days or when confidence drops below 0.8).

---

## Preferences Cloud Sync

After authenticating with `/auth login`, your preferences sync to Convex and follow you across devices.

### What Syncs

| Field | Local key | Cloud key |
|-------|-----------|-----------|
| Default model | `preferences.model.default` | `defaultModel` |
| Default provider | `preferences.model.provider` | `defaultProvider` |
| Communication style | `identity.communicationStyle` | `communicationStyle` |
| Language | `identity.language` | `language` |
| Git branch prefix | `preferences.git.branchPrefix` | `gitBranchPrefix` |
| Autonomy threshold | `preferences.autonomy.askThreshold` | `autonomyThreshold` |

### What Stays Local

These fields are machine-specific and never leave your device:

- `integrations.ollama` -- local model inventory
- `integrations.lmstudio` -- local model inventory
- `integrations.github` -- local auth state
- `preferences.voice` -- voice engine config
- `understanding` -- confidence scores and tracking

### Merge Strategy

The merge uses a **last-write-wins** strategy based on timestamps:

1. On login, `PreferencesSyncManager.syncOnLogin()` pulls cloud preferences.
2. If `cloudPrefs.updatedAt > localConfig.understanding.lastUpdated`, cloud values overwrite local.
3. If local is newer, local values are preserved.
4. After any `/preferences` change, `pushToCloud()` sends updated values to Convex.

Sync is always **best-effort** -- if Convex is unreachable, the operation silently fails and local state is authoritative.

### Authentication Flow

```
/auth login     # Opens browser for Clerk authentication
/auth status    # Shows current auth state
/auth logout    # Clears local tokens
```

The auth flow uses a terminal-to-browser device code pattern (see commit `2648c66`). After login, your Clerk ID is used to scope all cloud operations.

---

## Adaptive System Prompt

8gent personalizes its system prompt based on your onboarding data. The `USER_CONTEXT_SEGMENT` is injected into every agent turn.

### What Gets Injected

```
## USER CONTEXT
You are working with **James**.
Their role: Full-Stack Engineer.
Communication style: **concise** -- Be brief and direct. Skip explanations unless asked.
```

### Style Mapping

| Style | System prompt instruction |
|-------|--------------------------|
| `concise` | Be brief and direct. Skip explanations unless asked. |
| `detailed` | Explain your reasoning. Teach as you go. |
| `casual` | Keep it friendly and collaborative. We're partners. |
| `formal` | Maintain professional tone. Be precise. |

### Language

If `identity.language` is set to anything other than `"en"`, the system prompt includes:

```
Respond in: pt-BR
```

The agent will then respond in the specified language while keeping code comments and identifiers in English.

### When Personalization Activates

The user context block is injected when either condition is true:

- `onboardingComplete === true`
- `identity.name` is set (even if onboarding was skipped)

If neither condition is met, the agent runs with the default system prompt (no user context).

---

## Session History & Resume

8gent tracks your conversations and lets you pick up where you left off, even on a different machine.

### Checkpoints

Session data is saved to Convex automatically:

- **Message checkpoint:** every 60 seconds if new messages exist (via `startCheckpointTimer`)
- **Token/tool-call deltas:** flushed every 10 seconds to the `sessions` table
- **On session end:** final totals are written and the session is marked as ended

Each checkpoint stores:

- Session ID
- User ID
- Conversation title (derived from first user message, max 80 chars)
- Message count
- Model name
- Working directory
- Checkpoint data (messages truncated to 4000 chars each)

### Commands

| Command | Aliases | Description |
|---------|---------|-------------|
| `/history` | `/hist`, `/sessions` | Browse all past sessions |
| `/resume` | `/res` | Resume a recent session (pick from last 5) |
| `/continue` | `/cont`, `/last` | Continue the most recent session automatically |
| `/compact` | `/compress`, `/summarize` | Summarize and compress the current conversation |

### Cross-Device Resume

Because checkpoints sync to Convex, you can start a session on your laptop and resume it on your desktop:

1. Run `/auth login` on both machines.
2. Start working on machine A.
3. On machine B, run `/resume` to see recent sessions from machine A.
4. Select the session to continue -- the checkpoint data loads into context.

### Compact Mode

`/compact` summarizes the current conversation into a condensed form, reducing token usage while preserving key context. Useful for long sessions that are approaching context window limits.

---

## Personal LoRA Training

8gent collects high-quality session traces for personal LoRA fine-tuning via the `PersonalCollector`.

### How Collection Works

After each agent turn, the response is evaluated and optionally collected as a training pair:

```
prompt  -> The user's message / instruction
response -> The model's response
score    -> PRM judge score (0.0-1.0)
model    -> Which model generated the response
```

### Quality Filters

A training pair is only collected if **all** of the following are true:

| Filter | Threshold |
|--------|-----------|
| PRM judge score | >= 0.7 |
| User did not correct the response | `userCorrected === false` |
| All tool calls succeeded | `toolCallsSucceeded === true` |
| Response length | >= 50 characters |

If any filter fails, the pair is counted in `totalFiltered` but not written to disk.

### Data Location

```
.8gent/kernel/training/
  pairs.jsonl    # Training pairs (one JSON object per line)
  stats.json     # Collection statistics
```

Each line in `pairs.jsonl` follows this schema:

```json
{
  "userId": "user_abc123",
  "sessionId": "sess_1710000000000",
  "prompt": "Fix the TypeScript error in auth.ts",
  "response": "The issue is a missing type annotation...",
  "score": 0.85,
  "model": "deepseek-coder-v2:16b",
  "toolCallsSucceeded": true,
  "userCorrected": false,
  "collectedAt": 1710000000000
}
```

### Checking Stats

The `stats.json` file tracks:

```json
{
  "totalCollected": 142,
  "totalFiltered": 58,
  "averageScore": 0.82,
  "lastCollectedAt": 1710000000000
}
```

The collection ratio (`totalCollected / (totalCollected + totalFiltered)`) tells you what percentage of your interactions meet the quality bar. A healthy ratio is 60-80%.

### Enabling the Training Pipeline

Collection happens automatically. To enable the full RL training pipeline (GRPO batches, checkpoint validation, auto-promotion), set in `.8gent/config.json`:

```json
{
  "training_proxy": {
    "enabled": true
  }
}
```

See `docs/KERNEL-FINETUNING.md` for the full training pipeline architecture.

---

## ESC to Interrupt

Press **ESC** during generation to abort the current agent response. The agent stops immediately -- no partial output is committed, and you can type a new prompt.

The ESC key is handled via the `useHotkeys` hook in the TUI, which binds `key.escape` to the abort handler.

---

## Slash Commands Reference

All personalization-related slash commands:

| Command | Aliases | Description |
|---------|---------|-------------|
| `/onboarding` | `/onboard`, `/setup`, `/intro` | Start or restart personalization setup |
| `/preferences` | `/prefs`, `/settings` | View or edit your preferences |
| `/skip` | `/later` | Skip current onboarding question (`/skip all` to skip everything) |
| `/auth` | `/login`, `/account` | Authentication (`/auth login`, `/auth logout`, `/auth status`) |
| `/model` | `/m` | Select LLM model |
| `/provider` | `/pr` | Select LLM provider |
| `/voice` | `/v` | Voice TTS settings (`/voice on`, `/voice off`, `/voice test`) |
| `/language` | `/lang`, `/l` | Set response language (`/language pt-BR`) |
| `/history` | `/hist`, `/sessions` | Browse past sessions |
| `/resume` | `/res` | Resume a recent session (pick from last 5) |
| `/continue` | `/cont`, `/last` | Continue most recent session automatically |
| `/compact` | `/compress`, `/summarize` | Summarize and compress current conversation |
| `/infinite` | `/inf` | Enable infinite/autonomous mode |
| `/adhd` | `/bionic`, `/focus` | Toggle ADHD/bionic reading mode |
| `/status` | `/s`, `/st` | Show session status |

---

## Configuration

### `.8gent/user.json`

The primary personalization file. Created by onboarding, updated by preferences changes.

```json
{
  "version": "0.1.0",
  "onboardingComplete": true,
  "completedSteps": ["identity", "role", "projects", "communication", "confirmation"],
  "lastPrompted": "2025-03-15T10:00:00.000Z",
  "promptCount": 47,

  "identity": {
    "name": "James",
    "role": "Full-Stack Engineer",
    "communicationStyle": "concise",
    "language": "en"
  },

  "projects": {
    "primary": "8gent-code",
    "all": ["8gent-code", "foodstack"],
    "descriptions": {
      "8gent-code": "Autonomous coding agent TUI"
    }
  },

  "preferences": {
    "voice": {
      "enabled": false,
      "engine": null,
      "voiceId": null
    },
    "model": {
      "default": "deepseek-coder-v2:16b",
      "provider": "ollama",
      "fallbacks": ["qwen2.5-coder:7b"],
      "preferLocal": true
    },
    "git": {
      "autoPush": false,
      "autoCommit": true,
      "branchPrefix": "8gent/",
      "commitStyle": "conventional"
    },
    "autonomy": {
      "askThreshold": "fatal-only",
      "infiniteByDefault": false
    }
  },

  "integrations": {
    "github": {
      "authenticated": true,
      "username": "jamesspalding"
    },
    "mcps": [],
    "ollama": {
      "available": true,
      "models": ["deepseek-coder-v2:16b", "qwen2.5-coder:7b", "llama3.2:3b"]
    },
    "lmstudio": {
      "available": false,
      "models": []
    }
  },

  "understanding": {
    "confidenceScore": 0.75,
    "areasUnclear": [],
    "lastUpdated": "2025-03-15T10:00:00.000Z"
  }
}
```

### `.8gent/config.json` Sync Flags

The project-level config controls sync behavior:

```json
{
  "sync": {
    "enabled": true,
    "convexUrl": "https://your-deployment.convex.cloud"
  },
  "training_proxy": {
    "enabled": false
  }
}
```

| Flag | Default | Description |
|------|---------|-------------|
| `sync.enabled` | `true` | Enable Convex cloud sync for preferences and sessions |
| `sync.convexUrl` | deployment URL | Convex deployment endpoint |
| `training_proxy.enabled` | `false` | Enable RL fine-tuning pipeline |

### Autonomy Thresholds

The `askThreshold` setting controls when 8gent pauses to ask for permission:

| Value | Behavior |
|-------|----------|
| `"always"` | Ask before every action |
| `"important"` | Ask before destructive or irreversible actions |
| `"fatal-only"` | Only ask before potentially dangerous operations (default) |
| `"never"` | Full autonomy -- never ask |

---

## Architecture

Personalization spans several packages in the monorepo:

```
packages/
  self-autonomy/
    onboarding.ts          # OnboardingManager: auto-detect, questions, user config
    preferences-sync.ts    # PreferencesSyncManager: Convex cloud sync
    heartbeat.ts           # HeartbeatAgents: background context/memory sync
    index.ts               # SelfAutonomy engine, AutoGit, SelfHeal, SessionMemory

  eight/
    agent.ts               # Injects USER_CONTEXT_SEGMENT into system prompt
    prompts/
      system-prompt.ts     # USER_CONTEXT_SEGMENT builder, style mapping
    session-sync.ts        # SessionSyncManager: checkpoint saving, session resume
    types.ts               # AgentConfig (systemPrompt field)

  kernel/
    personal-collector.ts  # PersonalCollector: training pair collection + filtering
    training.ts            # GRPO batch collection, checkpoint validation
    manager.ts             # KernelManager entry point
    judge.ts               # PRM scoring via Gemini Flash

  auth/
    index.ts               # Clerk + GitHub OAuth, device code flow

  db/
    convex/
      conversations.ts     # Conversation checkpoints (upsert, getRecent)
      schema.ts            # Convex schema for sessions, conversations, preferences

  memory/                  # Knowledge graph + extraction for long-term memory

apps/
  tui/
    src/
      components/
        command-input.tsx   # Slash command definitions and routing
      hooks/
        useHotkeys.ts       # ESC key binding for interrupt
      screens/
        HistoryScreen.tsx   # Session history browser
```

### Data Flow

```
First Launch
  -> OnboardingManager.autoDetect()
  -> 3-question flow
  -> writes .8gent/user.json

Each Session
  -> agent reads user.json
  -> USER_CONTEXT_SEGMENT injected into system prompt
  -> SessionSyncManager tracks tokens/tools
  -> checkpoints saved every 60s
  -> PersonalCollector filters + stores training pairs

On /auth login
  -> PreferencesSyncManager.syncOnLogin()
  -> cloud prefs merged with local (updatedAt wins)

On /preferences change
  -> local user.json updated
  -> PreferencesSyncManager.pushToCloud()
```

### Confidence Score

The `understanding.confidenceScore` (0.0--1.0) represents how well 8gent knows you. It is calculated from five equally-weighted categories:

| Category | Weight | How it scores |
|----------|--------|---------------|
| Identity | 20% | name (10%), role (5%), communication style (5%) |
| Projects | 20% | primary project (15%), project list (5%) |
| Preferences | 20% | provider (10%), default model (5%), voice setting (5%) |
| Integrations | 20% | local models available (10%), GitHub authenticated (10%) |
| Usage patterns | 20% | scales with `promptCount` up to 50 interactions |

When confidence drops below 0.8, or 7 days pass since the last prompt, 8gent may ask a follow-up clarification question to fill in gaps.
