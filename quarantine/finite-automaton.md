# Quarantine: Finite Automaton

## Status

Quarantined - not wired into agent tools or package exports yet.

## What it does

Zero-dependency deterministic finite automaton (DFA) for pattern matching and
state machine transitions. Useful for agent conversation flow control, input
validation, and structured command parsing.

Capabilities:

- **addState(id, accepting)** - register a state, mark as accepting (terminal) or not
- **setStart(id)** - designate the start state
- **addTransition(from, symbol, to)** - add a single-character transition; `"*"` acts as wildcard
- **run(input)** - feed a string through the DFA; returns `{ accepted, finalState, trace }`
- **minimize()** - strip unreachable states and dead transitions in-place
- **reachable()** - return the set of states reachable from start
- **DFA.fromLiteral(pattern)** - factory: exact-string matcher
- **DFA.fromCharset(chars, minLen)** - factory: accepts strings composed only of the given character set

Raises `DFAError` (extends `Error`) on config mistakes: unknown state references,
transition conflicts, or running without a start state set.

## File

`packages/tools/finite-automaton.ts` (~130 lines)

## Usage

```typescript
import { DFA } from "./packages/tools/finite-automaton.ts";

// Exact string match
const dfa = DFA.fromLiteral("yes");
console.log(dfa.run("yes").accepted);  // true
console.log(dfa.run("no").accepted);   // false

// Manual DFA - accepts binary strings ending in "1"
const binary = new DFA();
binary.addState("q0").addState("q1", true).setStart("q0");
binary.addTransition("q0", "0", "q0");
binary.addTransition("q0", "1", "q1");
binary.addTransition("q1", "0", "q0");
binary.addTransition("q1", "1", "q1");
console.log(binary.run("101").accepted); // true
console.log(binary.run("100").accepted); // false

// Alphanumeric-only validator
const alphanum = DFA.fromCharset("abcdefghijklmnopqrstuvwxyz0123456789");
console.log(alphanum.run("hello123").accepted); // true
console.log(alphanum.run("hello!").accepted);   // false
```

## Integration path

1. Add to `packages/eight/tools.ts` so agents can build inline validators for
   conversation branch routing (e.g., validate slot values before API calls)
2. Export from `packages/tools/index.ts` once at least one agent use-case is
   validated in benchmarks
3. Use in `packages/permissions/policy-engine.ts` as a fast path for
   symbol-level input pattern guards before full YAML policy evaluation
4. Potential use in `packages/self-autonomy/reflection.ts` to model
   session-state transitions (idle -> working -> reflecting -> idle)

## Before promoting

- [ ] Add benchmark harness test proving `run()` accepts/rejects correctly
- [ ] Validate `minimize()` correctness on a known multi-state machine
- [ ] Export from `packages/tools/index.ts`
- [ ] Wire into at least one agent flow with a measured outcome (e.g., slot
      validation pass-rate in conversation benchmarks)
