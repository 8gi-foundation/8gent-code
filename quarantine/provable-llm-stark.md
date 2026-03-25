# Quarantine: Provable LLM Computation via STARKs

## Source
- X: @AbdelStark (Mar 23, 2026)
- "Can LLMs be PROVABLE computers?"

## Key Insights
- Percepta showed transformers can BE computers - compiled weights, deterministic execution, 30k tokens/sec
- Built a STARK verification layer to prove LLM computed correctly
- Zero-knowledge proofs for AI output verification

## Relevance to 8gent
- Our validation package (packages/validation/) does checkpoint-verify-revert
- Provable computation could make agent actions verifiable
- Trust layer for autonomous agents - prove they did what they said
- Could feed into our NemoClaw policy engine for cryptographic approval
- Enterprise feature: prove to clients that the agent's output is deterministic

## What to Build
1. Research Percepta's verification approach
2. Prototype a simple output verification for our harness results
3. Add to docs as a future trust/verification architecture
