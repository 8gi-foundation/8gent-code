# env-detector

**Tool name:** env-detector
**Description:** Detects runtime environment characteristics including CI provider, container status, OS details, shell type, and terminal capabilities. Returns a typed `EnvProfile` object covering CI (GitHub Actions, GitLab CI, Jenkins, CircleCI, Travis, Buildkite), Docker/Kubernetes container detection, OS platform and arch, shell name and path, terminal color depth, TTY status, and viewport dimensions.

**Status:** quarantine
**Location:** `packages/tools/env-detector.ts`

## Exports

- `detectEnv(): EnvProfile` - main entry point, returns full environment profile
- `EnvProfile` - full typed profile
- Sub-types: `CIProfile`, `ContainerProfile`, `OSProfile`, `ShellProfile`, `TerminalProfile`

## Integration path

1. Wire into `packages/tools/index.ts` as a named export
2. Expose as an agent tool in `packages/eight/tools.ts` so the agent can self-query its runtime context
3. Use in `packages/permissions/policy-engine.ts` to auto-adjust policy (e.g. headless mode in CI, stricter sandbox in Docker)
4. Feed OS/shell info into `packages/eight/prompts/system-prompt.ts` for context-aware responses

## Usage

```ts
import { detectEnv } from "./env-detector";

const env = detectEnv();
console.log(env.ci.provider);     // "github-actions" | null
console.log(env.container.isDocker); // true | false
console.log(env.terminal.hasColor);  // true | false
```
