# Quarantine: system-info

## What

Cross-platform system information collector. Gathers OS details, CPU (with load average), RAM, GPU, disk usage, installed runtimes, network interfaces, and connectivity checks into a single structured report.

## File

`packages/tools/system-info.ts` (~220 lines)

## API

```ts
import { getSystemInfo, formatReport } from './packages/tools/system-info.ts';

const info = await getSystemInfo();   // SystemReport object
console.log(formatReport(info));      // human-readable string
```

## What it collects

| Category | Details |
|----------|---------|
| OS | platform, version/release, arch, hostname |
| CPU | model name, core count, 1/5/15m load average |
| RAM | total, used, and free (GB) |
| GPU | macOS chipset model, NVIDIA via nvidia-smi, AMD via lspci |
| Disk | root (`/`) and `/home` filesystem usage |
| Runtimes | bun, node, deno, python3, go, rustc, java, ollama, docker, git, gh, ffmpeg |
| Network interfaces | all non-internal IPv4 and IPv6 addresses via `node:os` |
| Connectivity | HEAD checks to github.com, openrouter.ai, eight-vessel.fly.dev with latency |

## CLI usage

```bash
bun run packages/tools/system-info.ts
```

## Platform support

- macOS: `sysctl`, `sw_vers`, `vm_stat`, `system_profiler`
- Linux: `/proc/cpuinfo`, `/proc/meminfo`, `nvidia-smi`, `lspci`
- Network interfaces via `node:os` - works on both

## Why quarantined

New implementation, untested in CI. Needs:

- [ ] Tests
- [ ] Wire into `packages/tools/index.ts` exports
- [ ] Add as an agent-callable tool in `packages/eight/tools.ts`
- [ ] Validate on Linux (CI runner)
