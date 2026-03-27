# load-balancer-config

Load balancer configuration builder supporting round-robin, weighted, and least-connections.

## Requirements
- roundRobin(backends[]): assigns requests cyclically
- weighted(backends[], weights[]): distributes by weight
- leastConnections(backends[], connections{}): selects backend with fewest connections
- healthCheck(config, { path, interval, threshold }): attaches health check
- renderConfig(lb): formatted load balancer configuration

## Status

Quarantine - pending review.

## Location

`packages/tools/load-balancer-config.ts`
