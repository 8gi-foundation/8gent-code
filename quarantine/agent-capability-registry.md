# agent-capability-registry

Registry of agent capabilities with discovery, matching, and dependency resolution.

## Requirements
- register(registry, capability, { description, inputs, outputs, tags[] })
- find(registry, query): returns matching capabilities by tag or description keyword
- resolve(registry, goal): suggests capability chain to achieve a goal
- dependencies(registry, capabilityId): returns required capabilities
- renderRegistry(registry): formatted capability catalog

## Status

Quarantine - pending review.

## Location

`packages/tools/agent-capability-registry.ts`
