/**
 * System Information Collector for 8gent
 *
 * Collects OS, CPU, RAM, GPU, disk, installed runtimes, network interfaces,
 * and connectivity checks. Cross-platform: macOS + Linux.
 *
 * Usage:
 *   import { getSystemInfo } from './packages/tools/system-info.ts';
 *   const info = await getSystemInfo();
 *
 * CLI:
 *   bun run packages/tools/system-info.ts
 */

export interface ToolStatus {
  name: string;
  installed: boolean;
  version: string | null;
}

export interface NetworkInterface {
  name: string;
  address: string;
  family: "IPv4" | "IPv6";
  internal: boolean;
}

export interface NetworkCheck {
  host: string;
  reachable: boolean;
  latencyMs: number | null;
}

export interface DiskEntry {
  filesystem: string;
  sizeGB: number;
  usedGB: number;
  availGB: number;
  mountpoint: string;
}

export interface SystemReport {
  timestamp: string;
  os: {
    platform: string;
    release: string;
    arch: string;
    hostname: string;
  };
  cpu: {
    model: string;
    cores: number;
    loadAvg: [number, number, number] | null;
  };
  ram: {
    totalGB: number;
    freeGB: number;
    usedGB: number;
  };
  gpu: string | null;
  disk: DiskEntry[];
  runtimes: ToolStatus[];
  networkInterfaces: NetworkInterface[];
  network: NetworkCheck[];
}

// ---- helpers ----------------------------------------------------------------

async function shell(cmd: string): Promise<string> {
  try {
    const proc = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
    return (await new Response(proc.stdout).text()).trim();
  } catch {
    return "";
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---- collectors -------------------------------------------------------------

async function collectOS() {
  const platform = process.platform;
  const arch = process.arch;
  const hostname = (await shell("hostname")) || "unknown";
  let release = "";
  if (platform === "darwin") {
    release = await shell("sw_vers -productVersion");
  } else {
    release = await shell("uname -r");
  }
  return { platform, release: release || "unknown", arch, hostname };
}

async function collectCPU() {
  const cores = navigator?.hardwareConcurrency ?? parseInt(await shell("nproc") || "0", 10);

  let model = "";
  if (process.platform === "darwin") {
    model = await shell("sysctl -n machdep.cpu.brand_string 2>/dev/null");
    if (!model) {
      // Apple Silicon
      model = await shell("sysctl -n machdep.cpu.brand_string 2>/dev/null || sysctl -n hw.model 2>/dev/null");
    }
  } else {
    model = await shell("grep -m1 'model name' /proc/cpuinfo | cut -d: -f2");
  }

  let loadAvg: [number, number, number] | null = null;
  const loadRaw = await shell("uptime");
  const loadMatch = loadRaw.match(/load averages?:\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (loadMatch) {
    loadAvg = [parseFloat(loadMatch[1]), parseFloat(loadMatch[2]), parseFloat(loadMatch[3])];
  }

  return { model: model.trim() || "unknown", cores, loadAvg };
}

async function collectRAM() {
  let totalGB = 0;
  let freeGB = 0;

  if (process.platform === "darwin") {
    const total = await shell("sysctl -n hw.memsize");
    totalGB = total ? parseInt(total, 10) / 1073741824 : 0;
    const pageFree = await shell("vm_stat | awk '/Pages free/ {gsub(\".\",\"\",$3); print $3}'");
    const pageInactive = await shell("vm_stat | awk '/Pages inactive/ {gsub(\".\",\"\",$3); print $3}'");
    const free = (parseInt(pageFree || "0", 10) + parseInt(pageInactive || "0", 10)) * 4096;
    freeGB = free / 1073741824;
  } else {
    const meminfo = await shell("cat /proc/meminfo");
    const totalMatch = meminfo.match(/MemTotal:\s+(\d+)/);
    const availMatch = meminfo.match(/MemAvailable:\s+(\d+)/);
    totalGB = totalMatch ? parseInt(totalMatch[1], 10) / 1048576 : 0;
    freeGB = availMatch ? parseInt(availMatch[1], 10) / 1048576 : 0;
  }

  totalGB = round1(totalGB);
  freeGB = round1(freeGB);
  return { totalGB, freeGB, usedGB: round1(totalGB - freeGB) };
}

async function collectGPU(): Promise<string | null> {
  if (process.platform === "darwin") {
    const gpu = await shell(
      "system_profiler SPDisplaysDataType 2>/dev/null | grep 'Chipset Model' | head -1 | cut -d: -f2"
    );
    return gpu.trim() || null;
  }
  // NVIDIA
  const nvidia = await shell("nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1");
  if (nvidia) return nvidia;
  // AMD / generic
  const amd = await shell(
    "lspci 2>/dev/null | grep -i 'vga\\|3d\\|display' | head -1 | sed 's/.*: //'"
  );
  return amd || null;
}

async function collectDisk(): Promise<DiskEntry[]> {
  // -P for POSIX output, consistent across macOS/Linux
  const raw = await shell("df -P -BG 2>/dev/null || df -g 2>/dev/null");
  const lines = raw.split("\n").filter(Boolean);
  const result: DiskEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(/\s+/);
    if (parts.length < 6) continue;
    const mountpoint = parts[parts.length - 1];
    // Only include root and home to avoid noise
    if (mountpoint !== "/" && mountpoint !== "/home") continue;
    result.push({
      filesystem: parts[0],
      sizeGB: parseInt(parts[1], 10) || 0,
      usedGB: parseInt(parts[2], 10) || 0,
      availGB: parseInt(parts[3], 10) || 0,
      mountpoint,
    });
  }
  return result;
}

async function checkRuntime(name: string, versionFlag = "--version"): Promise<ToolStatus> {
  const output = await shell(`${name} ${versionFlag} 2>&1 | head -1`);
  const notFound = !output || output.toLowerCase().includes("not found") || output.toLowerCase().includes("command not found");
  return { name, installed: !notFound, version: notFound ? null : output };
}

async function collectRuntimes(): Promise<ToolStatus[]> {
  return Promise.all([
    checkRuntime("bun"),
    checkRuntime("node"),
    checkRuntime("deno"),
    checkRuntime("python3"),
    checkRuntime("go", "version"),
    checkRuntime("rustc"),
    checkRuntime("java", "-version"),
    checkRuntime("ollama"),
    checkRuntime("docker"),
    checkRuntime("git"),
    checkRuntime("gh"),
    checkRuntime("ffmpeg", "-version"),
  ]);
}

async function collectNetworkInterfaces(): Promise<NetworkInterface[]> {
  const os = await import("node:os");
  const ifaces = os.networkInterfaces();
  const result: NetworkInterface[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      result.push({
        name,
        address: addr.address,
        family: addr.family as "IPv4" | "IPv6",
        internal: addr.internal,
      });
    }
  }
  return result;
}

async function checkConnectivity(host: string): Promise<NetworkCheck> {
  const start = performance.now();
  try {
    const resp = await fetch(`https://${host}`, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    return {
      host,
      reachable: resp.ok || resp.status < 500,
      latencyMs: Math.round(performance.now() - start),
    };
  } catch {
    return { host, reachable: false, latencyMs: null };
  }
}

// ---- public API -------------------------------------------------------------

/**
 * Collect full system information. Cross-platform (macOS + Linux).
 */
export async function getSystemInfo(): Promise<SystemReport> {
  const [os, cpu, ram, gpu, disk, runtimes, networkInterfaces, github, openrouter, fly] =
    await Promise.all([
      collectOS(),
      collectCPU(),
      collectRAM(),
      collectGPU(),
      collectDisk(),
      collectRuntimes(),
      collectNetworkInterfaces(),
      checkConnectivity("github.com"),
      checkConnectivity("openrouter.ai"),
      checkConnectivity("eight-vessel.fly.dev"),
    ]);

  return {
    timestamp: new Date().toISOString(),
    os,
    cpu,
    ram,
    gpu,
    disk,
    runtimes,
    networkInterfaces,
    network: [github, openrouter, fly],
  };
}

/** @deprecated Use getSystemInfo() */
export const collectSystemInfo = getSystemInfo;

export function formatReport(report: SystemReport): string {
  const ifaces = report.networkInterfaces
    .filter(i => !i.internal && i.family === "IPv4")
    .map(i => `  ${i.name}: ${i.address}`)
    .join("\n") || "  (none)";

  const lines: string[] = [
    `System Report - ${report.timestamp}`,
    "=".repeat(56),
    `OS:   ${report.os.platform} ${report.os.release} (${report.os.arch})`,
    `Host: ${report.os.hostname}`,
    `CPU:  ${report.cpu.model} (${report.cpu.cores} cores)${report.cpu.loadAvg ? ` load: ${report.cpu.loadAvg.join(" ")}` : ""}`,
    `RAM:  ${report.ram.usedGB}GB used / ${report.ram.totalGB}GB total (${report.ram.freeGB}GB free)`,
    `GPU:  ${report.gpu ?? "not detected"}`,
    "",
    "Disk:",
    ...report.disk.map(d => `  ${d.mountpoint}: ${d.usedGB}GB used / ${d.sizeGB}GB (${d.availGB}GB free)`),
    report.disk.length === 0 ? "  (no data)" : "",
    "",
    "Runtimes:",
    ...report.runtimes.map(t => `  ${t.installed ? "[ok]" : "[--]"} ${t.name}${t.version ? ` - ${t.version}` : ""}`),
    "",
    "Network Interfaces (external IPv4):",
    ifaces,
    "",
    "Connectivity:",
    ...report.network.map(n => `  ${n.reachable ? "[ok]" : "[--]"} ${n.host}${n.latencyMs != null ? ` (${n.latencyMs}ms)` : ""}`),
  ];

  return lines.join("\n");
}

// ---- CLI --------------------------------------------------------------------

if (import.meta.main) {
  const report = await getSystemInfo();
  console.log(formatReport(report));
}
