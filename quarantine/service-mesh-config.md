# service-mesh-config

Service mesh configuration builder for traffic policies, retries, timeouts, and circuit breaking.

## Requirements
- trafficPolicy({ service, retries, timeout, circuitBreaker }): returns policy config
- virtualService({ host, routes[], timeout }): HTTP routing rules
- destinationRule({ host, trafficPolicy, subsets[] }): Istio-compatible destination rule
- renderYAML(config): formatted service mesh YAML manifest

## Status

Quarantine - pending review.

## Location

`packages/tools/service-mesh-config.ts`
