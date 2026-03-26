# hallucination-detector

Detects likely hallucination patterns in LLM output: unverified specifics, contradictions, uncertainty markers.

## Requirements
- detectUncertaintyMarkers(text): flags hedging phrases (I believe, might be, I think)
- detectOverconfidence(text): flags absolute claims about specific numbers or dates
- checkFactConsistency(text, facts[]): finds contradictions with known facts
- score(text): 0-100 hallucination risk score
- renderReport(analysis): markdown hallucination risk report

## Status

Quarantine - pending review.

## Location

`packages/tools/hallucination-detector.ts`
