/**
 * Capability Detector for 8gent
 *
 * Detects installed tools (git, bun, node, docker, ollama, gh, ffmpeg),
 * reports versions, checks GPU availability, and recommends config.
 * Export: detectCapabilities()
 * CLI: bun run packages/tools/capability-detector.ts
 */

import { spawnSync } from "child_process";
import * as os from "os";

export interface ToolCapability {
  name: string;
  installed: boolean;
  version: string | null;
  path: string | null;
}

export interface GpuInfo {
  available: boolean;
  backend: "cuda" | "metal" | "rocm" | "none";
  devices: string[];
}

export interface ConfigRecommendation {
  key: string;
  value: string;
  reason: string;
}

export interface CapabilityReport {
  timestamp: string;
  platform: string;
  arch: string;
  tools: ToolCapability[];
  gpu: GpuInfo;
  recommendations: ConfigRecommendation[];
}

const TOOLS = [
  { name: "git", versionFlag: "--version" },
  { name: "bun", versionFlag: "--version" },
  { name: "node", versionFlag: "--version" },
  { name: "docker", versionFlag: "--version" },
  { name: "ollama", versionFlag: "--version" },
  { name: "gh", versionFlag: "--version" },
  { name: "ffmpeg", versionFlag: "-version" },
];

function which(cmd: string): string | null {
  const result = spawnSync("which", [cmd], { encoding: "utf8" });
  if (result.status === 0) return result.stdout.trim();
  return null;
}

function runVersionFlag(cmd: string, flag: string): string | null {
  const result = spawnSync(cmd, [flag], { encoding: "utf8", timeout: 5000 });
  if (result.status === 0) {
    const line = (result.stdout || result.stderr || "")
      .split("\n")
      .find((l) => l.trim().length > 0);
    return line?.trim() ?? null;
  }
  return null;
}

function probeTool(name: string, versionFlag: string): ToolCapability {
  const path = which(name);
  if (!path) return { name, installed: false, version: null, path: null };
  const version = runVersionFlag(name, versionFlag);
  return { name, installed: true, version, path };
}

function detectGpu(): GpuInfo {
  const platform = os.platform();

  if (platform === "darwin") {
    if (os.arch() === "arm64") {
      const gpuInfo = spawnSync(
        "system_profiler",
        ["SPDisplaysDataType", "-detailLevel", "mini"],
        { encoding: "utf8", timeout: 8000 }
      );
      const devices: string[] = [];
      for (const line of gpuInfo.stdout?.split("\n") ?? []) {
        if (line.trim().startsWith("Chipset Model:")) {
          devices.push(line.replace("Chipset Model:", "").trim());
        }
      }
      return {
        available: true,
        backend: "metal",
        devices: devices.length > 0 ? devices : ["Apple GPU (Metal)"],
      };
    }
    return { available: false, backend: "none", devices: [] };
  }

  if (platform === "linux") {
    const nvidiaSmi = spawnSync(
      "nvidia-smi",
      ["--query-gpu=name", "--format=csv,noheader"],
      { encoding: "utf8", timeout: 5000 }
    );
    if (nvidiaSmi.status === 0 && nvidiaSmi.stdout.trim().length > 0) {
      const devices = nvidiaSmi.stdout
        .trim()
        .split("\n")
        .map((d) => d.trim())
        .filter(Boolean);
      return { available: true, backend: "cuda", devices };
    }
    const rocmSmi = spawnSync("rocm-smi", ["--showproductname"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (rocmSmi.status === 0 && rocmSmi.stdout.trim().length > 0) {
      const devices = rocmSmi.stdout
        .split("\n")
        .filter((l) => l.includes("GPU"))
        .map((l) => l.trim())
        .filter(Boolean);
      return {
        available: true,
        backend: "rocm",
        devices: devices.length > 0 ? devices : ["AMD GPU (ROCm)"],
      };
    }
    return { available: false, backend: "none", devices: [] };
  }

  return { available: false, backend: "none", devices: [] };
}

function buildRecommendations(
  tools: ToolCapability[],
  gpu: GpuInfo
): ConfigRecommendation[] {
  const installed = new Set(
    tools.filter((t) => t.installed).map((t) => t.name)
  );
  const recs: ConfigRecommendation[] = [];

  recs.push({
    key: "provider",
    value: installed.has("ollama") ? "ollama" : "openrouter",
    reason: installed.has("ollama")
      ? "Ollama is installed - use local models for free, private inference"
      : "Ollama not found - use OpenRouter free tier (cloud, no cost)",
  });

  if (gpu.available && (gpu.backend === "metal" || gpu.backend === "cuda")) {
    recs.push({
      key: "ollama_num_gpu",
      value: "99",
      reason:
        gpu.backend === "metal"
          ? `Apple Metal GPU detected (${gpu.devices[0] ?? "unknown"}) - offload all layers for fast inference`
          : `CUDA GPU detected (${gpu.devices[0] ?? "unknown"}) - offload all layers`,
    });
  } else {
    recs.push({
      key: "ollama_num_gpu",
      value: "0",
      reason: "No GPU detected - CPU-only inference (slower but functional)",
    });
  }

  recs.push({
    key: "sandbox",
    value: installed.has("docker") ? "docker" : "process",
    reason: installed.has("docker")
      ? "Docker available - use container sandboxing for safer code execution"
      : "Docker not found - using process isolation (install Docker for stronger sandboxing)",
  });

  recs.push({
    key: "enable_media_tools",
    value: installed.has("ffmpeg") ? "true" : "false",
    reason: installed.has("ffmpeg")
      ? "ffmpeg installed - audio/video processing tools enabled"
      : "ffmpeg not found - media processing disabled (install ffmpeg to enable)",
  });

  recs.push({
    key: "enable_github_tools",
    value: installed.has("gh") ? "true" : "false",
    reason: installed.has("gh")
      ? "gh CLI installed - GitHub PR, issue, and release tools enabled"
      : "gh CLI not found - GitHub tools disabled (install gh to enable)",
  });

  return recs;
}

export async function detectCapabilities(): Promise<CapabilityReport> {
  const tools = TOOLS.map((t) => probeTool(t.name, t.versionFlag));
  const gpu = detectGpu();
  const recommendations = buildRecommendations(tools, gpu);
  return {
    timestamp: new Date().toISOString(),
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    tools,
    gpu,
    recommendations,
  };
}

if (import.meta.main) {
  const report = await detectCapabilities();
  const sep = "-".repeat(60);
  console.log("\n8gent Capability Detector");
  console.log(sep);
  console.log(`Platform : ${report.platform}`);
  console.log(`Arch     : ${report.arch}`);
  console.log(`Timestamp: ${report.timestamp}`);
  console.log(sep);
  console.log("\nInstalled Tools:");
  for (const t of report.tools) {
    const status = t.installed ? "yes" : "NO ";
    const pad = " ".repeat(Math.max(1, 10 - t.name.length));
    console.log(`  ${t.name}${pad}[${status}]  ${t.version ?? "n/a"}`);
  }
  console.log("\nGPU:");
  if (report.gpu.available) {
    console.log(`  Backend : ${report.gpu.backend}`);
    for (const d of report.gpu.devices) {
      console.log(`  Device  : ${d}`);
    }
  } else {
    console.log("  No GPU detected (CPU-only)");
  }
  console.log("\nConfig Recommendations:");
  for (const r of report.recommendations) {
    console.log(`  ${r.key} = ${r.value}`);
    console.log(`    reason: ${r.reason}`);
  }
  console.log(sep);
}
