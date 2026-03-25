# Quarantine: Project Scaffolder

## Status: Quarantine (not wired into main tool index)

## What it does

`packages/tools/project-scaffolder.ts` generates new project directories with boilerplate following 8gent conventions. Three templates:

| Template | What you get |
|----------|-------------|
| `bun-ts` | Bun TypeScript project - src/index.ts, tests, biome lint, bun:test |
| `nextjs` | Next.js app router - layout, page, globals.css, turbopack dev |
| `react-lib` | React component library - Button example, peer deps, bun build |

All templates use:
- `@8gent/<name>` package naming
- ES2022 target, ESNext modules, bundler resolution
- Strict TypeScript
- `.gitignore` with node_modules, dist, .env

## Usage

```bash
# CLI
bun run packages/tools/project-scaffolder.ts bun-ts my-tool
bun run packages/tools/project-scaffolder.ts nextjs my-app /tmp/my-app
bun run packages/tools/project-scaffolder.ts react-lib my-components

# Programmatic
import { scaffold } from "./packages/tools/project-scaffolder";
const result = scaffold({ template: "bun-ts", name: "my-tool" });
// result.root = absolute path, result.files = list of created files
```

## Why quarantined

- Needs real-world usage to validate template quality
- May want to add more templates (Tauri app, monorepo workspace, etc.)
- Should eventually integrate with Eight's tool system as a callable tool
- No tests yet beyond manual verification

## Exit criteria

1. Used successfully to scaffold at least 2 real projects
2. Unit tests covering all 3 templates
3. Wired into `packages/tools/index.ts` exports
4. Agent can invoke it as a tool action
