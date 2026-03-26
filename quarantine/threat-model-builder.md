# threat-model-builder

STRIDE threat model builder for system components with attack trees and mitigations.

## Requirements
- addComponent(model, { name, type, dataFlows[] })
- addThreat(model, componentId, { stride, description, mitigation, risk })
- strideCategories(): Spoofing, Tampering, Repudiation, Information Disclosure, DoS, EoP
- riskMatrix(model): severity vs likelihood matrix
- renderReport(model): markdown threat model report per component

## Status

Quarantine - pending review.

## Location

`packages/tools/threat-model-builder.ts`
