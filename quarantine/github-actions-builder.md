# github-actions-builder

GitHub Actions workflow YAML builder for CI/CD pipelines with common job templates.

## Requirements
- createWorkflow({ name, on[], env{} }): workflow shell
- addJob(workflow, { id, runsOn, steps[] })
- stepCheckout(options?): actions/checkout step
- stepSetupNode(version): actions/setup-node step
- stepCache(key, paths[]): actions/cache step
- render(workflow): YAML string output

## Status

Quarantine - pending review.

## Location

`packages/tools/github-actions-builder.ts`
