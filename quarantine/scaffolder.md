# quarantine: scaffolder

**Status:** quarantine - pending review before promotion

## What it is

`packages/tools/scaffolder.ts` - monorepo package scaffolder for 8gent-code.

Generates boilerplate for the four artifact kinds in the monorepo:

| Template | Destination | What it generates |
|----------|-------------|-------------------|
| `package` | `packages/<name>/` | `package.json`, `tsconfig.json`, `index.ts`, `<name>.ts`, `types.ts`, `README.md` |
| `app` | `apps/<name>/` | `package.json`, `tsconfig.json`, `src/index.tsx`, `src/App.tsx`, `README.md` |
| `benchmark` | `benchmarks/categories/<name>/` | `index.ts` (typed `BenchmarkDefinition[]`), `README.md` |
| `tool` | `packages/tools/<name>.ts` | single self-contained tool file |

## Exports

```ts
export type TemplateKind = "package" | "app" | "benchmark" | "tool";

export interface ScaffoldOptions {
  template: TemplateKind;
  name: string;       // lowercase letters, numbers, hyphens only
  root?: string;      // defaults to cwd
  dryRun?: boolean;
}

export interface ScaffoldResult {
  dir: string;
  files: string[];
  dryRun: boolean;
}

export async function scaffold(options: ScaffoldOptions): Promise<ScaffoldResult>
```

## CLI usage

```bash
bun run packages/tools/scaffolder.ts --template package   --name my-lib
bun run packages/tools/scaffolder.ts --template app       --name my-app
bun run packages/tools/scaffolder.ts --template benchmark --name my-bench
bun run packages/tools/scaffolder.ts --template tool      --name my-tool
bun run packages/tools/scaffolder.ts --template package   --name my-lib --dry-run
```

## Constraints

- Does not modify any existing file.
- Refuses to overwrite an existing destination directory (package/app/benchmark).
- Name validation: `^[a-z0-9-]+$` - anything else throws before writing.
- Tool template appends a single `.ts` file into existing `packages/tools/`.

## Promotion checklist

- [ ] Tests pass (`bun test`)
- [ ] Dry-run output verified for all 4 templates
- [ ] `scaffold()` import verified from another package
- [ ] No files outside `packages/tools/scaffolder.ts` modified
