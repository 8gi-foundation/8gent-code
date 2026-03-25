# Voice Commands - Quarantine

## What

Voice command registry for Lil Eight. Defines trigger phrases, fuzzy matching, and a plugin-extensible registry.

## File

`packages/pet/voice-commands.ts` (~130 lines)

## Built-in Commands

| ID | Triggers | Handler |
|----|----------|---------|
| open-app | "open [app]", "launch [app]", "start [app]" | handleOpenApp |
| search | "search [query]", "look up [query]", "find [query]" | handleSearch |
| play-music | "play music", "play some music", "put on music" | handlePlayMusic |
| what-time | "what time is it", "whats the time", "tell me the time" | handleWhatTime |
| screenshot | "take a screenshot", "screenshot", "capture screen" | handleScreenshot |
| airdrop | "airdrop that", "airdrop it", "send via airdrop" | handleAirdrop |
| switch-language | "switch to [language]", "speak [language]" | handleSwitchLanguage |

## Design

- **Fuzzy matching** via Levenshtein distance with a configurable threshold (default 0.55)
- **Parameterized triggers** - brackets like `[app]` extract the trailing text as a parameter
- **Plugin extensible** - `registry.register()` adds commands, `registry.unregister()` removes them
- **No external deps** - pure TypeScript, zero imports

## Graduation Criteria

- [ ] Wire handlers to actual pet actions (open app via `osascript`, search via browser power, etc.)
- [ ] Connect to speech-to-text input pipeline
- [ ] Add tests for fuzzy matching edge cases
- [ ] Integrate with pet widget state for visual feedback

## Risks

- Levenshtein is O(mn) but inputs are short voice phrases so performance is fine
- Threshold tuning may need adjustment once real voice-to-text output is flowing (STT errors are different from typos)
