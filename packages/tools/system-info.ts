/**
 * System Information Collector for 8gent
 *
 * Detects hardware, installed tools, running models, disk space, and network
 * connectivity. Returns a structured report for diagnostics and onboarding.
 */

export interface ToolStatus {
  name: string;
  installed: boolean;
  version: string | null;
}

export interface NetworkCheck {
  host: string;
  reachable: boolean;
  latencyMs: number | null;
}

export interface SystemReport {
  timestamp: string;
  os: { platform: string; release: string; arch: string; hostname: string };
  cpu: { model: string; cores: number };
  ram: { totalGB: number; freeGB: number };
  gpu: string | null;
  disk: { filesystem: string; sizeGB: number; usedGB: number; availGB: number; mountpoint: string }[];
  tools: ToolStatus[];
  ollamaModels: string[];
  network: NetworkCheck[];
}

async function runShell(cmd: string): Promise<string> {
  try {
    const proc = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
    const text = await new Response(proc.stdout).text();
    return text.trim();
  } catch {
    return "";
  }
}

async function getOS() {
  const platform = process.platform;
  const release = await runShell("uname -r");
  const arch = process.arch;
  const hostname = (await runShell("hostname")) || "unknown";
  return { platform, release, arch, hostname };
}

async function getCPU() {
  const cores = navigator?.hardwareConcurrency ?? parseInt(await runShell("nproc") || "0", 10);
  let model = "";
  if (process.platform === "darwin") {
    model = await runShell("sysctl -n machdep.cpu.brand_string");
  } else {
    model = await runShell("grep -m1 'model name' /proc/cpuinfo | cut -d: -f2");
  }
  return { model: model.trim() || "unknown", cores };
}

async function getRAM() {
  let totalGB = 0;
  let freeGB = 0;
  if (process.platform === "darwin") {
    const total = await runShell("sysctl -n hw.memsize");
    totalGB = total ? parseInt(total, 10) / 1073741824 : 0;
    const free = await runShell("vm_stat | awk '/Pages free/ {print $3}' | tr -d '.'");
    freeGB = free ? (parseInt(free, 10) * 4096) / 1073741824 : 0;
  } else {
    const meminfo = await runShell("cat /proc/meminfo");
    const totalMatch = meminfo.match(/MemTotal:\s+(\d+)/);
    const freeMatch = meminfo.match(/MemAvailable:\s+(\d+)/);
    totalGB = totalMatch ? parseInt(totalMatch[1], 10) / 1048576 : 0;
    freeGB = freeMatch ? parseInt(freeMatch[1], 10) / 1048576 : 0;
  }
  return { totalGB: Math.round(totalGB * 10) / 10, freeGB: Math.round(freeGB * 10) / 10 };
}

async function getGPU(): Promise<string | null> {
  if (process.platform === "darwin") {
    const gpu = await runShell("system_profiler SPDisplaysDataType 2>/dev/null | grep 'Chipset Model' | head -1 | cut -d: -f2");
    return gpu.trim() || null;
  }
  const nvidia = await runShell("nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1");
  return nvidia || null;
}

async function getDisk() {
  const raw = await runShell("df -g / 2>/dev/null || df -BG / 2>/dev/null");
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  const parts = lines[1].split(/\s+/);
  if (parts.length < 6) return [];
  return [{
    filesystem: parts[0],
    sizeGB: parseInt(parts[1], 10) || 0,
    usedGB: parseInt(parts[2], 10) || 0,
    availGB: parseInt(parts[3], 10) || 0,
    mountpoint: parts[parts.length - 1],
  }];
}

async function checkTool(name: string, versionFlag = "--version"): Promise<ToolStatus> {
  const output = await runShell(`${name} ${versionFlag} 2>&1 | head -1`);
  const installed = output.length > 0 && !output.toLowerCase().includes("not found");
  return { name, installed, version: installed ? output : null };
}

async function getTools(): Promise<ToolStatus[]> {
  return Promise.all([
    checkTool("bun"), checkTool("node"), checkTool("ollama"),
    checkTool("git"), checkTool("python3"), checkTool("docker"),
  ]);
}

async function getOllamaModels(): Promise<string[]> {
  const raw = await runShell("ollama list 2>/dev/null | tail -n +2");
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map(l => l.split(/\s+/)[0]);
}

async function checkNetwork(host: string): Promise<NetworkCheck> {
  const start = performance.now();
  try {
    const resp = await fetch(`https://${host}`, { method: "HEAD", signal: AbortSignal.timeout(5000) });
    const latencyMs = Math.round(performance.now() - start);
    return { host, reachable: resp.ok || resp.status < 500, latencyMs };
  } catch {
    return { host, reachable: false, latencyMs: null };
  }
}

export async function collectSystemInfo(): Promise<SystemReport> {
  const [os, cpu, ram, gpu, disk, tools, ollamaModels, github, openrouter] = await Promise.all([
    getOS(), getCPU(), getRAM(), getGPU(), getDisk(), getTools(), getOllamaModels(),
    checkNetwork("github.com"), checkNetwork("openrouter.ai"),
  ]);

  return {
    timestamp: new Date().toISOString(),
    os, cpu, ram, gpu, disk, tools, ollamaModels,
    network: [github, openrouter],
  };
}

export function formatReport(report: SystemReport): string {
  const lines: string[] = [
    `System Report - ${report.timestamp}`,
    `${"=".repeat(50)}`,
    `OS: ${report.os.platform} ${report.os.release} (${report.os.arch})`,
    `Host: ${report.os.hostname}`,
    `CPU: ${report.cpu.model} (${report.cpu.cores} cores)`,
    `RAM: ${report.ram.freeGB}GB free / ${report.ram.totalGB}GB total`,
    `GPU: ${report.gpu ?? "not detected"}`,
    "",
    "Disk:",
    ...report.disk.map(d => `  ${d.mountpoint}: ${d.availGB}GB free / ${d.sizeGB}GB total`),
    "",
    "Tools:",
    ...report.tools.map(t => `  ${t.installed ? "[ok]" : "[--]"} ${t.name}${t.version ? ` - ${t.version}` : ""}`),
    "",
    "Ollama Models:",
    ...(report.ollamaModels.length ? report.ollamaModels.map(m => `  - ${m}`) : ["  (none)"]),
    "",
    "Network:",
    ...report.network.map(n => `  ${n.reachable ? "[ok]" : "[--]"} ${n.host}${n.latencyMs ? ` (${n.latencyMs}ms)` : ""}`),
  ];
  return lines.join("\n");
}

// CLI entry point
if (import.meta.main) {
  const report = await collectSystemInfo();
  console.log(formatReport(report));
}
