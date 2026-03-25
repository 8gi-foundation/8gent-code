# Quarantine: system-info

## What

System information collector - gathers hardware specs, installed tools, Ollama models, disk space, and network connectivity into a structured report.

## File

`packages/tools/system-info.ts` (~140 lines)

## API

```ts
import { collectSystemInfo, formatReport } from './packages/tools/system-info.ts';

const report = await collectSystemInfo(); // structured SystemReport object
console.log(formatReport(report));        // human-readable string
```

## What it detects

| Category | Details |
|----------|---------|
| OS | platform, kernel release, arch, hostname |
| CPU | model name, core count |
| RAM | total and free (GB) |
| GPU | macOS chipset or nvidia-smi |
| Disk | root filesystem usage |
| Tools | bun, node, ollama, git, python3, docker |
| Ollama | lists installed models |
| Network | HEAD request to github.com and openrouter.ai with latency |

## CLI usage

```bash
bun run packages/tools/system-info.ts
```

## Why quarantined

New file, untested in CI, no integration with existing tool registry yet. Needs:

- [ ] Tests
- [ ] Wire into `packages/tools/index.ts` exports
- [ ] Add as an agent-callable tool in `packages/eight/tools.ts`
- [ ] Validate cross-platform (Linux)
