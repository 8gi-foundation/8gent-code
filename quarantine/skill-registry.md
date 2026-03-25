# Quarantine: skill-registry

## What

A lightweight, zero-dependency skill registry for the Eight agent. Skills are
named units of capability - each has a name, description, priority, a set of
trigger patterns, and a handler function. The registry matches a raw input
string against all registered skills, resolves priority conflicts, and
optionally runs the winning handler.

Designed to sit between the REPL / TUI input layer and the agent loop: if a
skill matches, it short-circuits the LLM call and handles the input directly.

## File

`packages/eight/skill-registry.ts` (~270 lines)

## API

```ts
import {
  SkillRegistry,
  getSkillRegistry,
  type SkillDefinition,
  type SkillResult,
} from './packages/eight/skill-registry';

// ---- Register a skill ----
const registry = new SkillRegistry();

registry.register({
  name: 'clear-screen',
  description: 'Clears the terminal screen',
  priority: 80,
  triggers: [
    { type: 'exact', value: '/clear' },
    { type: 'exact', value: 'clear' },
  ],
  handler: async (_input, _ctx): Promise<SkillResult> => {
    process.stdout.write('\x1Bc');
    return { ok: true, output: 'Screen cleared.' };
  },
  tags: ['tui', 'utility'],
});

// ---- Register many at once ----
registry.registerAll([skillA, skillB]);

// ---- Match input (no execution) ----
const match = registry.match('/clear');
// match.skill.name  => 'clear-screen'
// match.trigger     => { type: 'exact', value: '/clear' }
// match.priority    => 80

// ---- All matches sorted by priority ----
const all = registry.matchAll('play lofi');

// ---- Run the winning handler ----
const result = await registry.run('/clear');
// result.ok     => true
// result.output => 'Screen cleared.'

// ---- Run all matching skills, stop at first ok===true ----
const result2 = await registry.runFirst('play lofi');

// ---- Enable / disable ----
registry.disable('clear-screen');
registry.enable('clear-screen');
registry.isEnabled('clear-screen'); // => true

// ---- Priority override (runtime, does not mutate the definition) ----
registry.setPriority('clear-screen', 90);

// ---- Introspection ----
registry.list();                          // all skills
registry.list({ tag: 'tui' });            // filtered by tag
registry.list({ enabled: true });         // enabled only
registry.stats();
// => { total: 1, enabled: 1, disabled: 0, byTag: { tui: 1, utility: 1 } }

// ---- Module-level singleton (optional) ----
const shared = getSkillRegistry();
shared.register({ name: 'help', ... });
```

## Trigger Types

| Type       | Behavior                                     | Example value |
|------------|----------------------------------------------|---------------|
| `exact`    | Case-insensitive exact match                 | `/help`       |
| `prefix`   | Input starts with value (case-insensitive)   | `/play `      |
| `contains` | Input contains value anywhere                | `lofi`        |
| `regex`    | Full regex test against input                | `^/dj\s+.*`  |

Within a skill, triggers are tested in order. The first matching trigger is
used. Only one trigger per skill fires per `match()` call.

## Priority Resolution

- Range: 0 (lowest) to 100 (highest). Default: 50.
- When multiple skills match the same input, the highest priority wins.
- Ties are broken by registration order (first registered wins).
- Runtime `setPriority()` overrides the definition's priority without mutation.

## Integration Points

Intended insertion points once promoted out of quarantine:

- `packages/eight/repl.ts` - check `registry.match(input)` before passing to
  agent loop. Slash commands become skills.
- `packages/eight/agent.ts` - check at the top of `chat()` for skill
  short-circuits that avoid an LLM call entirely.
- `apps/tui/` - register TUI-specific skills (screen management, view switches)
  and pass input through the registry before the chat pipeline.
- `packages/music/` - `dj` and `radio` commands registered as skills with
  `prefix` triggers so `/dj play lofi` routes without a prompt round-trip.

Minimal integration sketch for the REPL:

```ts
// repl.ts
import { getSkillRegistry } from '../eight/skill-registry';

const registry = getSkillRegistry();
// ... register slash-command skills at startup ...

async function handleInput(raw: string) {
  const result = await registry.run(raw);
  if (result) {
    if (result.output) console.log(result.output);
    return; // skill handled it - no LLM call needed
  }
  // fall through to agent.chat(raw)
}
```

## Why quarantined

New file, not yet wired into the agent loop or TUI. Needs:

- [ ] Unit tests: exact/prefix/contains/regex triggers, priority resolution,
      enable/disable toggling, runFirst fallthrough, handler errors caught
- [ ] Integration test: register a real slash-command skill and run it through
      the REPL input path
- [ ] Wire into `packages/eight/repl.ts` - replace ad-hoc slash-command
      string-matching with skill lookups
- [ ] Seed initial skill set: `/help`, `/clear`, `/dj`, `/memory`, `/status`
- [ ] Add `SkillRegistry` to `packages/eight/index.ts` exports
- [ ] Benchmark: measure match latency at 50, 200, 500 registered skills to
      confirm O(n*t) is acceptable (n=skills, t=avg triggers per skill)
