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
- **addTransition(from, symbol, to)** - single-character transition; "*" acts as wildcard
- **run(input)** - feed a string through the DFA; returns { accepted, finalState, trace }
- **minimize()** - strip unreachable states and dead transitions in-place
- **reachable()** - return the set of states reachable from start
- **DFA.fromLiteral(pattern)** - factory: exact-string matcher
- **DFA.fromCharset(chars, minLen)** - factory: accepts strings of the given charset only

Raises DFAError (extends Error) on config mistakes.

## File

packages/tools/finite-automaton.ts (~130 lines)

## Integration path

1. Add to packages/eight/tools.ts for inline slot validators in conversation flow
2. Export from packages/tools/index.ts once validated in benchmarks
3. Use in packages/permissions/policy-engine.ts for fast symbol-level input guards
4. Model session-state transitions in packages/self-autonomy/reflection.ts

## Before promoting

- [ ] Harness test proving run() accept/reject correctness
- [ ] Validate minimize() on a known multi-state machine
- [ ] Export from packages/tools/index.ts
- [ ] Wire into one agent flow with measured outcome
