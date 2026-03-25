# Quarantine: Training Data Collection

## Problem

We need a way to extract high-quality (prompt, response) pairs from agent sessions and export them in a format suitable for model fine-tuning.

## What was built

`packages/kernel/data-curator.ts` - a training data curation tool that:

1. Reads raw pairs from `.8gent/kernel/training/pairs.jsonl` (written by `PersonalCollector`)
2. Applies quality filters: minimum score (0.75), minimum length, error pattern detection, correction rejection
3. Exports accepted pairs as ShareGPT-format JSONL for fine-tuning
4. Reports token counts and estimated training cost

## Usage

```bash
bun run packages/kernel/data-curator.ts --output training-pairs.jsonl
```

## Quality filters

- Minimum prompt length: 10 chars
- Minimum response length: 100 chars
- Minimum PRM judge score: 0.75
- Rejects pairs where user corrected the response
- Rejects pairs where tool calls failed
- Rejects responses containing error patterns (stack traces, ENOENT, etc.)

## Output format

ShareGPT JSONL - each line is a JSON object:

```json
{
  "conversations": [
    { "from": "human", "value": "..." },
    { "from": "gpt", "value": "..." }
  ],
  "source": "8gent-sessions",
  "score": 0.85,
  "model": "qwen3.5:latest",
  "session_id": "abc123",
  "collected_at": 1711324800000
}
```

## Dependencies

- `PersonalCollector` (`packages/kernel/personal-collector.ts`) must be collecting pairs during sessions
- No external dependencies beyond Node.js fs/path

## Files

| File | Lines | Purpose |
|------|-------|---------|
| `packages/kernel/data-curator.ts` | ~170 | Curation logic + CLI |
| `quarantine/training-data-collection.md` | this file | Spec |

## Graduation criteria

- [ ] End-to-end test with real session data
- [ ] Validate ShareGPT format against common fine-tuning tools (axolotl, etc.)
- [ ] Add deduplication (same prompt appearing across sessions)
- [ ] Wire into kernel manager as an export command
