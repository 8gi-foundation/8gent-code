# contract-clause-builder

Library of standard contract clauses that can be assembled into a binding agreement skeleton.

## Requirements
- getClause(type): returns clause text for types: payment, ip, confidentiality, termination, liability, dispute
- buildContract(clauses, parties): assembles full contract with party names interpolated
- listClauses(): returns all available clause types with one-line descriptions
- validateContract(contract): checks that required clauses (payment, termination) are present

## Status

Quarantine - pending review.

## Location

`packages/tools/contract-clause-builder.ts`
