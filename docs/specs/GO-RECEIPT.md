# /go Receipt Schema

Status: draft v1
Owner: 8PO (Samantha)
Cross-reference: #2607 (this spec), #2608 (verdict copy + lint), epic #2605

The receipt is what every surface (TUI, Electron, Telegram bridge, JSON SDK) renders when a `/go` run reaches a terminal state. Same fields on every surface. Same order. Same length budget.

This is not a log. This is the artifact the user sees when they come back from making coffee. It must answer three questions in under three seconds: did it work, where is the proof, what did it cost.

---

## 1. Verdict line

One sentence. Eight words or fewer. TTS-able. Lower-case sentence, full stop, no emoji, no AI-speak.

Allowed terminal verdicts (must match one of these stems, copy locked in `packages/eight/go/verdicts.ts`):

| State      | Stem                | Example                                             |
| ---------- | ------------------- | --------------------------------------------------- |
| achieved   | `Done.`             | `Done. Goal met at turn 12.`                        |
| stopped    | `Stopped.`          | `Stopped. Couldn't get past the failing test.`      |
| needs-you  | `Needs you.`        | `Needs you. Same failure three times in a row.`     |

Mid-run progress lines (`Still going. Sub-goal 2 of 4.`) are NOT receipts. They render on the live focal strip and disappear at terminal state.

The verdict line is the only field allowed to be spoken via TTS. Everything below is read silently.

### Banned tokens in verdict line

Enforced by lint rule (8DO, #2608):

```
successfully | great news | I've | I am | I'll | working on
AI | model | Claude | Anthropic | OpenAI | LLM
em dash | emoji | exclamation mark
```

---

## 2. Evidence

Exactly one primary evidence link. Optional secondary evidence list.

```
EVIDENCE
  primary: <one URL or absolute path>
  secondary:
    - <URL or path>
    - <URL or path>
```

Primary evidence is the single artifact the user clicks to verify the claim. Examples:

- File created: absolute path
- File modified: absolute path + git diff URL if committed
- PR opened: PR URL
- Test passing: log path with the green line highlighted
- Screen recording: absolute path to `.mov` in `~/.8gent/runs/<run-id>/recording.mov`

Rule: if there is no primary evidence, the verdict cannot be `Done.` It must downgrade to `Needs you.` Done without evidence is a bug.

---

## 3. Cost + duration

Four fields, fixed order, plain numbers, units after the number.

```
COST
  tokens:        <int_in> in / <int_out> out
  usd:           <decimal_or_zero> (local-only: 0)
  wall_clock:    <hh:mm:ss>
  sub_agents:    <int>
```

`usd: 0` is the desired state on local-only runs. Any non-zero value means a cloud fallback fired. The surface must color this field amber when non-zero, never red (it is a tradeoff, not a fault).

`sub_agents` counts spawned children from `claude-code/src/tools/AgentTool/forkSubagent.ts`. Includes the judge if the judge ran as a sub-agent.

---

## 4. Display rules

### TUI (Ink v6)

```
Done. Goal met at turn 12.
~/Downloads/_clean.log
12.3k in / 4.1k out · $0.00 · 02:14 · 3 agents
```

Three lines. No box. No separator characters. Default focus is the verdict line. Ctrl+G expands to the full receipt block in a scroll pane.

### Electron (8gent Computer)

Card. Three sections, vertical. Verdict line at 18pt. Evidence link as a button labeled with the filename or PR number, not the full URL. Cost as small caption below.

The card animates in once on terminal state. Never animates on mid-run updates.

### ADHD mode

ADHD mode renders only the verdict line. Cost and evidence stay one tap/keystroke away. Default for users with `accessibility.adhd = true` in their profile.

ADHD mode never auto-expands. The user opens the receipt explicitly. This is the rule because expansion-on-arrival is the exact thing that pulls attention away from the next task.

### Voice (KittenTTS, terminal only)

Speaks the verdict line. Once. Never speaks evidence or cost. Never speaks mid-run updates.

KittenTTS is the only approved voice. ElevenLabs is never used for receipt playback (cost + dependency).

The voice fires once at terminal state. If the user starts another `/go` before the previous receipt is spoken, the queued speech is dropped, not delayed.

### JSON SDK

Surfaces consuming the receipt over the daemon RPC receive this exact shape:

```json
{
  "run_id": "01J...",
  "verdict": {
    "state": "achieved",
    "line": "Done. Goal met at turn 12."
  },
  "evidence": {
    "primary": "/Users/.../downloads-clean.log",
    "secondary": []
  },
  "cost": {
    "tokens_in": 12345,
    "tokens_out": 4123,
    "usd": 0,
    "wall_clock_ms": 134567,
    "sub_agents": 3
  },
  "ledger_url": "file:///Users/.../runs/<run-id>/ledger.jsonl"
}
```

The `ledger_url` field is required and points at the hash-chained append-only ledger (8GO concern). Third-party callers verify the run by reading the ledger, not by trusting the receipt fields alone.

---

## 5. Anti-patterns

Things the receipt MUST NOT do. Each one is a regression and gets a test in `packages/eight/go/__tests__/verdict-copy.test.ts`.

- Use the word "successfully", "great news", "amazing", "excited", "I've", "I am", or "I'll" anywhere in the verdict or evidence label.
- Use an em dash anywhere. Use a hyphen or rewrite the sentence.
- Use an emoji in the verdict line.
- Use color as the only differentiator between achieved / stopped / needs-you. The verdict stem must be readable in a screen reader monotone.
- Quote tool output or stack traces in the verdict line. Stack traces belong in the ledger.
- Show "I" as the subject. The receipt is about the work, not the agent.
- Surface the underlying model name. The user does not care if it was apfel or Ollama. They care that it worked.
- Pad cost numbers with "(estimated)" or "approximately". Numbers or absent. No qualifiers.
- Render mid-run updates with the same shape as the receipt. The receipt is the terminal artifact, full stop.
- Bury the verdict below the evidence or cost. Verdict is always first, always largest, always read first.

Cross-reference: 8DO sub-issue #2608 owns the lint rule that enforces the banned-token list at build time.

---

## Open questions for the boardroom

1. When a run is resumed (`/go resume <run-id>`), does the receipt show cumulative cost across resumptions or only the latest segment? (Default proposal: cumulative, with a `resumed_from` field on the JSON shape.)
2. When the judge disagrees with execution evidence (e.g. tests pass but judge says goal not met), which wins? (Default proposal: judge wins on goal-met, execution wins on cost/duration.)
3. For walk-away runs (>5 min), do we ship a Telegram receipt mirror automatically or only on opt-in? (Default proposal: opt-in per-run via `/go --notify telegram`.)
