/**
 * API Health Checker - monitors external API health for 8gent services.
 *
 * Targets: Ollama (local), OpenRouter (cloud), GitHub API, Telegram Bot API.
 * Reports latency (ms) and up/down status per endpoint.
 * Designed to run standalone via `bun run packages/proactive/api-health-checker.ts`
 * or imported and called on a cron interval.
 */

export interface HealthResult {
  service: string;
  url: string;
  status: "up" | "down";
  latencyMs: number;
  httpStatus?: number;
  error?: string;
  checkedAt: string;
}

export interface HealthReport {
  timestamp: string;
  results: HealthResult[];
  summary: { up: number; down: number; avgLatencyMs: number };
}

const ENDPOINTS = [
  { service: "Ollama", url: "http://127.0.0.1:11434/api/tags" },
  { service: "OpenRouter", url: "https://openrouter.ai/api/v1/models" },
  { service: "GitHub", url: "https://api.github.com/zen" },
  { service: "Telegram Bot", url: "https://api.telegram.org/bot{token}/getMe" },
] as const;

function resolveTelegramUrl(url: string): string {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? process.env.BROTHERHOOD_TELEGRAM_BOT_TOKEN ?? "";
  return url.replace("{token}", token);
}

async function pingEndpoint(service: string, rawUrl: string, timeoutMs = 8000): Promise<HealthResult> {
  const url = service === "Telegram Bot" ? resolveTelegramUrl(rawUrl) : rawUrl;
  const checkedAt = new Date().toISOString();
  const start = performance.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { "User-Agent": "8gent-health/1.0" },
    });

    clearTimeout(timer);
    const latencyMs = Math.round(performance.now() - start);

    return {
      service,
      url: rawUrl,
      status: res.ok ? "up" : "down",
      latencyMs,
      httpStatus: res.status,
      checkedAt,
    };
  } catch (err: unknown) {
    const latencyMs = Math.round(performance.now() - start);
    const message = err instanceof Error ? err.name === "AbortError" ? "timeout" : err.message : String(err);
    return { service, url: rawUrl, status: "down", latencyMs, error: message, checkedAt };
  }
}

export async function checkAllHealth(): Promise<HealthReport> {
  const results = await Promise.all(ENDPOINTS.map((e) => pingEndpoint(e.service, e.url)));

  const up = results.filter((r) => r.status === "up").length;
  const down = results.length - up;
  const avgLatencyMs = Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / results.length);

  return {
    timestamp: new Date().toISOString(),
    results,
    summary: { up, down, avgLatencyMs },
  };
}

/** Run checks on an interval. Returns a cleanup function. */
export function startCron(intervalMs = 60_000, onReport?: (r: HealthReport) => void): () => void {
  const run = async () => {
    const report = await checkAllHealth();
    if (onReport) onReport(report);
    else printReport(report);
  };

  // Fire immediately then repeat.
  run();
  const id = setInterval(run, intervalMs);
  return () => clearInterval(id);
}

function printReport(report: HealthReport): void {
  console.log(`\n--- API Health Check ${report.timestamp} ---`);
  for (const r of report.results) {
    const tag = r.status === "up" ? "OK" : "FAIL";
    const detail = r.error ? ` (${r.error})` : ` (HTTP ${r.httpStatus})`;
    console.log(`  [${tag}] ${r.service.padEnd(14)} ${String(r.latencyMs).padStart(5)}ms${detail}`);
  }
  const { up, down, avgLatencyMs } = report.summary;
  console.log(`  Summary: ${up} up, ${down} down, avg ${avgLatencyMs}ms\n`);
}

// --- CLI entry point ---
if (import.meta.main) {
  const isCron = process.argv.includes("--cron");
  if (isCron) {
    const interval = Number(process.argv[process.argv.indexOf("--cron") + 1]) || 60_000;
    console.log(`Starting health cron every ${interval}ms. Ctrl+C to stop.`);
    startCron(interval);
  } else {
    const report = await checkAllHealth();
    printReport(report);
    process.exit(report.summary.down > 0 ? 1 : 0);
  }
}
