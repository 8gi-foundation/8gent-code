/**
 * Configuration Validator for .8gent/config.json
 *
 * Reads the config file, validates schema, checks service connectivity,
 * and outputs a health report with actionable suggestions.
 */

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

// --- Types ---

interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  suggestion?: string;
}

interface ConfigHealthReport {
  timestamp: string;
  configPath: string;
  checks: CheckResult[];
  summary: { pass: number; warn: number; fail: number };
}

// --- Schema expectations ---

const REQUIRED_TOP_LEVEL = ["version", "name", "models", "safety"] as const;

const EXPECTED_SECTIONS = [
  "skills", "autonomy", "git", "models", "vision",
  "training_proxy", "safety", "auth", "db", "voice", "controlPlane",
] as const;

const VALID_COMMIT_STYLES = ["conventional", "semantic", "freeform"];
const VALID_ASK_THRESHOLDS = ["always", "risky", "fatal-only", "never"];
const DEFAULT_DAEMON_PORT = 18789;
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

// --- Helpers ---

function check(name: string, status: CheckResult["status"], message: string, suggestion?: string): CheckResult {
  return { name, status, message, ...(suggestion ? { suggestion } : {}) };
}

async function isReachable(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function isPortOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    await fetch(`http://${host}:${port}`, { signal: controller.signal });
    clearTimeout(timer);
    return true; // got a response - port is in use
  } catch (e: any) {
    if (e?.name === "AbortError") return false;
    // Connection refused means port is free
    if (e?.code === "ECONNREFUSED" || e?.message?.includes("ECONNREFUSED")) return false;
    // Other fetch error but connection happened - port is in use
    return true;
  }
}

// --- Validation checks ---

function validateSchema(config: Record<string, any>): CheckResult[] {
  const results: CheckResult[] = [];

  // Required top-level fields
  for (const field of REQUIRED_TOP_LEVEL) {
    if (config[field] === undefined) {
      results.push(check(`schema.${field}`, "fail", `Missing required field "${field}"`, `Add "${field}" to config`));
    } else {
      results.push(check(`schema.${field}`, "pass", `Field "${field}" present`));
    }
  }

  // Version format
  if (config.version && !/^\d+\.\d+\.\d+$/.test(config.version)) {
    results.push(check("schema.version_format", "warn", `Version "${config.version}" is not strict semver`, "Use x.y.z format"));
  }

  // Known sections - warn on unknown top-level keys
  const knownKeys = new Set([...REQUIRED_TOP_LEVEL, ...EXPECTED_SECTIONS, "personality", "syncToConvex"]);
  for (const key of Object.keys(config)) {
    if (!knownKeys.has(key)) {
      results.push(check(`schema.unknown_key`, "warn", `Unknown top-level key "${key}"`, "Remove or check spelling"));
    }
  }

  // Git commit style
  const style = config.git?.commitStyle;
  if (style && !VALID_COMMIT_STYLES.includes(style)) {
    results.push(check("schema.git.commitStyle", "warn", `Unknown commit style "${style}"`, `Use one of: ${VALID_COMMIT_STYLES.join(", ")}`));
  }

  // Autonomy threshold
  const threshold = config.autonomy?.askUserThreshold;
  if (threshold && !VALID_ASK_THRESHOLDS.includes(threshold)) {
    results.push(check("schema.autonomy.threshold", "warn", `Unknown threshold "${threshold}"`, `Use one of: ${VALID_ASK_THRESHOLDS.join(", ")}`));
  }

  // Safety - maxSelfModifyPerSession should be positive
  const maxMod = config.safety?.maxSelfModifyPerSession;
  if (maxMod !== undefined && (typeof maxMod !== "number" || maxMod < 1)) {
    results.push(check("schema.safety.maxModify", "fail", `maxSelfModifyPerSession must be a positive number`, "Set to 5 or higher"));
  }

  // Models - must have default
  if (config.models && !config.models.default) {
    results.push(check("schema.models.default", "fail", "No default model specified", "Set models.default to a valid model tag"));
  }

  return results;
}

async function checkOllama(config: Record<string, any>): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const preferLocal = config.models?.preferLocal !== false;

  if (!preferLocal) {
    results.push(check("ollama.skipped", "pass", "preferLocal is false - Ollama check skipped"));
    return results;
  }

  const reachable = await isReachable(DEFAULT_OLLAMA_URL);
  if (reachable) {
    results.push(check("ollama.connectivity", "pass", "Ollama is running and reachable"));
  } else {
    results.push(check("ollama.connectivity", "warn", "Ollama is not reachable at 127.0.0.1:11434", "Run `ollama serve` or set models.preferLocal to false"));
  }

  return results;
}

async function checkDaemonPort(config: Record<string, any>): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const port = config.controlPlane?.adminDashboardPort ?? DEFAULT_DAEMON_PORT;

  const inUse = await isPortOpen(port);
  if (inUse) {
    results.push(check("daemon.port", "warn", `Port ${port} is already in use`, "Stop the existing process or change controlPlane.adminDashboardPort"));
  } else {
    results.push(check("daemon.port", "pass", `Port ${port} is available`));
  }

  return results;
}

async function checkTrainingProxy(config: Record<string, any>): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const tp = config.training_proxy;

  if (!tp?.enabled) {
    results.push(check("training_proxy.skipped", "pass", "Training proxy is disabled - checks skipped"));
    return results;
  }

  // Proxy URL
  if (!tp.proxyUrl) {
    results.push(check("training_proxy.url", "fail", "Training proxy enabled but no proxyUrl set", "Set training_proxy.proxyUrl"));
  } else {
    const reachable = await isReachable(tp.proxyUrl);
    results.push(reachable
      ? check("training_proxy.connectivity", "pass", `Training proxy reachable at ${tp.proxyUrl}`)
      : check("training_proxy.connectivity", "warn", `Training proxy not reachable at ${tp.proxyUrl}`, "Start the proxy or set autoStart to true")
    );
  }

  // Base model
  if (!tp.baseModel) {
    results.push(check("training_proxy.baseModel", "warn", "No baseModel specified for training", "Set training_proxy.baseModel"));
  }

  // Config path
  if (tp.configPath) {
    const absPath = resolve(process.cwd(), tp.configPath);
    if (!existsSync(absPath)) {
      results.push(check("training_proxy.configPath", "warn", `Config file not found: ${tp.configPath}`, "Create the training proxy config or fix the path"));
    } else {
      results.push(check("training_proxy.configPath", "pass", `Config file exists: ${tp.configPath}`));
    }
  }

  return results;
}

// --- Main ---

export async function validateConfig(projectRoot?: string): Promise<ConfigHealthReport> {
  const root = projectRoot ?? process.cwd();
  const configPath = resolve(root, ".8gent/config.json");

  const report: ConfigHealthReport = {
    timestamp: new Date().toISOString(),
    configPath,
    checks: [],
    summary: { pass: 0, warn: 0, fail: 0 },
  };

  // File existence
  if (!existsSync(configPath)) {
    report.checks.push(check("file.exists", "fail", "Config file not found at .8gent/config.json", "Run `8gent init` or create the file manually"));
    report.summary.fail = 1;
    return report;
  }

  // Parse JSON
  let config: Record<string, any>;
  try {
    const raw = readFileSync(configPath, "utf-8");
    config = JSON.parse(raw);
    report.checks.push(check("file.parse", "pass", "Config file is valid JSON"));
  } catch (e: any) {
    report.checks.push(check("file.parse", "fail", `Invalid JSON: ${e.message}`, "Fix syntax errors in .8gent/config.json"));
    report.summary.fail = 1;
    return report;
  }

  // Run all checks
  const schemaChecks = validateSchema(config);
  const [ollamaChecks, daemonChecks, trainingChecks] = await Promise.all([
    checkOllama(config),
    checkDaemonPort(config),
    checkTrainingProxy(config),
  ]);

  report.checks.push(...schemaChecks, ...ollamaChecks, ...daemonChecks, ...trainingChecks);

  // Tally
  for (const c of report.checks) {
    report.summary[c.status]++;
  }

  return report;
}

export function formatReport(report: ConfigHealthReport): string {
  const lines: string[] = [
    `--- 8gent Config Health Report ---`,
    `Timestamp: ${report.timestamp}`,
    `Config:    ${report.configPath}`,
    ``,
  ];

  const icons = { pass: "[OK]", warn: "[!!]", fail: "[XX]" } as const;

  for (const c of report.checks) {
    lines.push(`  ${icons[c.status]} ${c.name} - ${c.message}`);
    if (c.suggestion) lines.push(`       -> ${c.suggestion}`);
  }

  lines.push(``);
  lines.push(`Summary: ${report.summary.pass} passed, ${report.summary.warn} warnings, ${report.summary.fail} failures`);

  if (report.summary.fail > 0) {
    lines.push(`Status: UNHEALTHY - fix failures before running`);
  } else if (report.summary.warn > 0) {
    lines.push(`Status: DEGRADED - review warnings`);
  } else {
    lines.push(`Status: HEALTHY`);
  }

  return lines.join("\n");
}

// CLI entry point
if (import.meta.main) {
  const report = await validateConfig();
  console.log(formatReport(report));
  process.exit(report.summary.fail > 0 ? 1 : 0);
}
