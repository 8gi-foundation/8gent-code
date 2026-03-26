# conversation-state-machine

Conversation flow state machine with intent detection, slot filling, and branching logic.

## Requirements
- defineState(machine, { name, prompt, slots[], transitions[] })
- transition(machine, state, userInput): returns next state based on matched transition
- fillSlots(state, userInput): extracts declared slot values from input
- isComplete(state): all required slots filled
- renderDiagram(machine): ASCII state diagram

## Status

Quarantine - pending review.

## Location

`packages/tools/conversation-state-machine.ts`
