# Quarantine: Personality Presets

## What

`packages/personality/presets.ts` - predefined personality configurations that control Eight's communication style.

## Presets

| Preset | Tone | Key Traits |
|--------|------|------------|
| **professional** | Formal, precise | Low humor, high directiveness, concise |
| **casual** | Friendly, relaxed | High humor, conversational, approachable |
| **teacher** | Patient, detailed | Max patience, high verbosity, explains the why |
| **mentor** | Encouraging, directive | High encouragement, high directiveness, growth-oriented |

## Interface

Each preset defines:

- `CommunicationStyle` - 6 numeric params (0-1): formality, verbosity, humor, encouragement, directiveness, patience
- Phrase sets: greetings, completion, error, thinking
- `systemDirective` - prompt fragment to steer model behavior

## API

```ts
import { getPreset, listPresets, getPresetPhrase, PRESETS } from "@8gent/personality/presets";

const preset = getPreset("teacher");
const greeting = getPresetPhrase(preset, "greetings");
const all = listPresets(); // [{ id, name, description }, ...]
```

## Integration Path

1. Wire into user preferences / onboarding (let user pick a preset)
2. Inject `preset.systemDirective` into system prompt via `USER_CONTEXT_SEGMENT`
3. Use `CommunicationStyle` params to control phrase frequency in `Voice` class
4. Allow per-session override via `/style` command

## Status

Quarantined. Not wired into any existing code. No existing files modified.

## Files

- `packages/personality/presets.ts` (~165 lines)
- `quarantine/personality-presets.md` (this file)
