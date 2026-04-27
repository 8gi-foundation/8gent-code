# blue-green-manager

Blue-green deployment state manager tracking which environment is live and managing cutover.

## Requirements
- createDeployment({ app, blue, green }): state object
- cutover(deployment, to): switches live environment
- rollback(deployment): reverts to previous live environment
- status(deployment): returns { live, standby, version, lastCutover }
- renderStatus(deployment): formatted deployment status card

## Status

Quarantine - pending review.

## Location

`packages/tools/blue-green-manager.ts`
