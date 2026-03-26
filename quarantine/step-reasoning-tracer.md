# step-reasoning-tracer

Traces chain-of-thought reasoning steps with validation, backtracking, and confidence scoring.

## Requirements
- addStep(trace, { thought, action, observation, confidence })
- validate(trace): checks each step has an observation before next thought
- backtrack(trace, stepIndex): rolls back to a previous step
- finalAnswer(trace, answer, confidence)
- renderTrace(trace): numbered reasoning trace with confidence scores

## Status

Quarantine - pending review.

## Location

`packages/tools/step-reasoning-tracer.ts`
