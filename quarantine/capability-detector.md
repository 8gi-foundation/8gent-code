# Capability Detector

**Package:** `packages/tools/capability-detector.ts`
**Status:** Quarantine - ready for review

## What it does

Probes the host system at runtime and produces a structured `CapabilityReport`:

- Checks 7 tools: `git`, `bun`, `node`, `docker`, `ollama`, `gh`, `ffmpeg`
- Reports install status, version string, and resolved path for each
- Detects GPU backend: Apple Metal (arm64 macOS), CUDA (nvidia-smi), ROCm (rocm-smi), or none
- Emits config key-value recommendations based on what is found

## API

```ts
import { detectCapabilities } from "./packages/tools/capability-detector.ts";
const report = await detectCapabilities();
```

### CapabilityReport shape

```ts
{
  timestamp: string;
  platform: string;         // "darwin 24.6.0"
  arch: string;             // "arm64"
  tools: ToolCapability[];  // per-tool install + version + path
  gpu: GpuInfo;             // backend + device list
  recommendations: ConfigRecommendation[]; // key=value + reason
}
```

## CLI

```bash
bun run packages/tools/capability-detector.ts
```

Verified output on this machine (Apple M2 Max):

```
8gent Capability Detector
------------------------------------------------------------
Platform : darwin 24.6.0
Arch     : arm64

Installed Tools:
  git       [yes]  git version 2.46.0
  bun       [yes]  1.2.5
  node      [yes]  v20.19.6
  docker    [yes]  Docker version 29.2.1, build a5c7197
  ollama    [yes]  ollama version is 0.18.2
  gh        [yes]  gh version 2.62.0 (2024-11-14)
  ffmpeg    [yes]  ffmpeg version 8.1

GPU:
  Backend : metal
  Device  : Apple M2 Max

Config Recommendations:
  provider = ollama
  ollama_num_gpu = 99
  sandbox = docker
  enable_media_tools = true
  enable_github_tools = true
```

## Design decisions

- No external deps - uses Node `child_process.spawnSync` and `os` only
- Timeouts on all probes (3-8 s) to prevent hangs on missing tools
- GPU: Metal on arm64 macOS, nvidia-smi CUDA on Linux, rocm-smi ROCm fallback
- Recommendations are additive and non-destructive - they suggest, callers apply

## What it does NOT do

- Does not write `.8gent/config.json` - callers decide what to apply
- Does not check network or disk (see `system-info.ts` for that)
- Does not require elevated permissions
