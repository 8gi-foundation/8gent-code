# risk-register

Project risk register with probability/impact scoring, mitigation plans, and heat map.

## Requirements
- addRisk(register, { description, probability, impact, owner, mitigation })
- riskScore(risk): probability * impact
- classify(risk): returns critical | high | medium | low
- renderHeatMap(register): ASCII 5x5 probability-impact heat map
- topRisks(register, n): returns top N risks by score

## Status

Quarantine - pending review.

## Location

`packages/tools/risk-register.ts`
