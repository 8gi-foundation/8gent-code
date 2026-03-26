# agent-memory-window

Sliding window memory for agent conversation context.

## Requirements
- AgentMemoryWindow with windowSize and summarize hook
- add(turn) appends and evicts when full
- getSummary() returns summary of evicted context
- getWindow() returns current visible turns
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/agent-memory-window.ts`
