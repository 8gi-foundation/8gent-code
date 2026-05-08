/**
 * port-scanner.ts
 * Check ports in use, find available ports, identify process owners.
 * Zero external dependencies. Uses only Node/Bun built-ins.
 */

import { createServer } from "net";
import { execSync } from "child_process";

export interface PortInfo {
  port: number;
  inUse: boolean;
  pid?: number;
  process?: string;
  address?: string;
}

/**
 * Check if a single port is in use and, if so, who owns it.
 */
export async function checkPort(port: number, host = "127.0.0.1"): Promise<PortInfo> {
  const inUse = await isPortInUse(port, host);

  if (!inUse) {
    return { port, inUse: false };
  }

  const owner = getProcessOwner(port);
  return {
    port,
    inUse: true,
    pid: owner?.pid,
    process: owner?.name,
    address: owner?.address,
  };
}

/**
 * Find the first available port in the given range [start, end].
 * Returns null if no port is free in the range.
 */
export async function findAvailable(
  start = 3000,
  end = 9999,
  host = "127.0.0.1"
): Promise<number | null> {
  for (let port = start; port <= end; port++) {
    const busy = await isPortInUse(port, host);
    if (!busy) return port;
  }
  return null;
}

/**
 * Scan a range of ports and return info for every port that is in use.
 */
export async function scanRange(
  start = 3000,
  end = 4000,
  host = "127.0.0.1"
): Promise<PortInfo[]> {
  const results: PortInfo[] = [];
  // Run checks in parallel batches of 50 to avoid fd exhaustion.
  const BATCH = 50;
  for (let base = start; base <= end; base += BATCH) {
    const batch = Array.from(
      { length: Math.min(BATCH, end - base + 1) },
      (_, i) => checkPort(base + i, host)
    );
    const settled = await Promise.all(batch);
    for (const info of settled) {
      if (info.inUse) results.push(info);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function isPortInUse(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code === "EADDRINUSE");
    });
    server.once("listening", () => {
      server.close(() => resolve(false));
    });
    server.listen(port, host);
  });
}

interface ProcessOwner {
  pid: number;
  name: string;
  address: string;
}

function getProcessOwner(port: number): ProcessOwner | null {
  try {
    // lsof is available on macOS and most Linux distros.
    const out = execSync(
      `lsof -nP -iTCP:${port} -sTCP:LISTEN 2>/dev/null || true`,
      { encoding: "utf8", timeout: 3000 }
    ).trim();

    if (!out) return null;

    const lines = out.split("\n").filter((l) => l && !l.startsWith("COMMAND"));
    if (!lines.length) return null;

    // COMMAND   PID   USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME
    const parts = lines[0].split(/\s+/);
    const name = parts[0] ?? "unknown";
    const pid = parseInt(parts[1] ?? "0", 10);
    const address = parts[8] ?? `*:${port}`;

    return { pid, name, address };
  } catch {
    // Fall back to ss/netstat if lsof is unavailable.
    try {
      const out = execSync(
        `ss -tlnp 2>/dev/null | grep :${port} || true`,
        { encoding: "utf8", timeout: 3000 }
      ).trim();
      if (!out) return null;
      const pidMatch = out.match(/pid=(\d+)/);
      const pid = pidMatch ? parseInt(pidMatch[1], 10) : 0;
      return { pid, name: "unknown", address: `*:${port}` };
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);

  const usage = `
Usage:
  bun packages/tools/port-scanner.ts check <port>
  bun packages/tools/port-scanner.ts find [start] [end]
  bun packages/tools/port-scanner.ts scan [start] [end]

Commands:
  check <port>           Report whether a port is in use and who owns it.
  find [start] [end]     Find the first available port in range (default 3000-9999).
  scan [start] [end]     List all occupied ports in range (default 3000-4000).
`.trim();

  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(usage);
    process.exit(0);
  }

  if (cmd === "check") {
    const port = parseInt(args[1] ?? "", 10);
    if (!port || isNaN(port)) {
      console.error("error: provide a port number");
      process.exit(1);
    }
    const info = await checkPort(port);
    if (info.inUse) {
      console.log(
        `port ${port} IN USE  pid=${info.pid ?? "?"} process=${info.process ?? "?"} addr=${info.address ?? "?"}`
      );
    } else {
      console.log(`port ${port} FREE`);
    }
  } else if (cmd === "find") {
    const start = parseInt(args[1] ?? "3000", 10);
    const end = parseInt(args[2] ?? "9999", 10);
    const port = await findAvailable(start, end);
    if (port === null) {
      console.log(`no free port found in range ${start}-${end}`);
      process.exit(1);
    } else {
      console.log(`${port}`);
    }
  } else if (cmd === "scan") {
    const start = parseInt(args[1] ?? "3000", 10);
    const end = parseInt(args[2] ?? "4000", 10);
    console.log(`scanning ${start}-${end}...`);
    const occupied = await scanRange(start, end);
    if (!occupied.length) {
      console.log("all clear - no ports in use in that range");
    } else {
      console.log(`${occupied.length} port(s) in use:`);
      for (const p of occupied) {
        console.log(
          `  ${String(p.port).padEnd(6)}  pid=${String(p.pid ?? "?").padEnd(8)}  process=${p.process ?? "?"}  addr=${p.address ?? "?"}`
        );
      }
    }
  } else {
    console.error(`unknown command: ${cmd}\n`);
    console.log(usage);
    process.exit(1);
  }
}
