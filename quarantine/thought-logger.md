# Quarantine: thought-logger

**File:** `packages/eight/thought-logger.ts`
**Status:** quarantine - not wired into agent loop yet
**Zero deps:** yes

## What it does

Structured chain-of-thought logging for the Eight agent.

| Category | When to use |
|----------|-------------|
| `PLAN` | Decomposing a goal into steps before acting |
| `REASON` | Evaluating options, working through uncertainty |
| `DECIDE` | Recording a final choice and why |
| `ACT` | Documenting a tool call or side-effect about to happen |
| `OBSERVE` | Capturing the result of an action |
| `REFLECT` | Post-step self-evaluation, lessons, corrections |

Chains are nestable. The full log exports as a `ThoughtTimeline`.

## API

```ts
import { ThoughtLogger, thoughtLogger } from "./thought-logger";

const log = thoughtLogger;
const chainId = log.startChain("solve-issue-42");

log.plan("Break into: read, edit, verify");
log.reason("Edit tool safer than Write for partial changes");
log.decide("Use Edit on src/agent.ts:88");
log.act("Calling Edit now");
log.observe("Edit succeeded");
log.reflect("Smaller diffs are faster to verify.");

log.endChain(chainId);

// Nested chain
log.withinChainSync("verify build", (id) => {
  log.act("tsc --noEmit", { chainId: id });
  log.observe("exit 0", { chainId: id });
});

const timeline = log.finish();
console.log(log.format());
```

## Integration points (not wired yet)

- `packages/eight/agent.ts` - wrap each tool-call cycle in a chain
- `packages/self-autonomy/reflection.ts` - pass timeline to post-session reflection
- `packages/validation/` - feed timeline to meta-eval for harness scoring

## Why quarantine

Not wired into the agent loop. No existing files were modified.
