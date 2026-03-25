/**
 * Error Classifier - categorizes errors and suggests recovery strategies.
 * Self-contained, no external deps. Used by agent self-healing loops.
 */

export type ErrorCategory =
  | "network"
  | "auth"
  | "permission"
  | "syntax"
  | "runtime"
  | "timeout"
  | "unknown";

export interface StackFrame {
  file: string;
  line: number | null;
  column: number | null;
  fn: string | null;
}

export interface ClassifiedError {
  category: ErrorCategory;
  message: string;
  originalError: unknown;
  stackFrames: StackFrame[];
  recoveryActions: string[];
  retryable: boolean;
  severity: "low" | "medium" | "high" | "fatal";
}

const NETWORK_PATTERNS = [
  /ECONNREFUSED/i, /ENOTFOUND/i, /ETIMEDOUT/i, /ECONNRESET/i,
  /network.*error/i, /fetch.*failed/i, /socket.*hang.*up/i, /getaddrinfo/i,
];

const AUTH_PATTERNS = [
  /unauthorized/i, /\b401\b/, /\b403\b/, /forbidden/i,
  /invalid.*token/i, /expired.*token/i, /authentication.*failed/i,
  /jwt.*expired/i, /api.*key/i,
];

const PERMISSION_PATTERNS = [
  /EACCES/i, /EPERM/i, /permission.*denied/i,
  /access.*denied/i, /not.*allowed/i, /insufficient.*privileges/i,
];

const SYNTAX_PATTERNS = [
  /SyntaxError/i, /unexpected.*token/i, /parse.*error/i,
  /invalid.*json/i, /unexpected.*end/i, /cannot parse/i,
];

const TIMEOUT_PATTERNS = [
  /timeout/i, /timed.*out/i, /ETIMEDOUT/i,
  /deadline.*exceeded/i, /request.*took.*too.*long/i,
];

const RUNTIME_PATTERNS = [
  /TypeError/i, /ReferenceError/i, /RangeError/i,
  /is not a function/i, /cannot read.*propert/i,
  /undefined is not/i, /null is not/i,
  /out of memory/i, /maximum call stack/i,
];

const RECOVERY: Record<ErrorCategory, string[]> = {
  network: [
    "Check network connectivity and DNS resolution",
    "Retry with exponential backoff (start at 1s, max 30s)",
    "Verify the target URL/host is reachable",
    "Check proxy or firewall settings if in restricted environment",
  ],
  auth: [
    "Refresh or rotate the API key / token",
    "Verify credentials in environment variables",
    "Check token expiry and re-authenticate if needed",
    "Confirm the correct auth scope/permissions are granted",
  ],
  permission: [
    "Check file or resource ownership and mode bits",
    "Run with elevated privileges if safe to do so",
    "Verify the agent has write access to the target path",
    "Use an alternative path within the allowed sandbox",
  ],
  syntax: [
    "Validate JSON/YAML structure before parsing",
    "Log the raw input and inspect for malformed characters",
    "Re-fetch the source if it may have been truncated",
    "Check for BOM or encoding issues in the input",
  ],
  runtime: [
    "Log the full stack trace and inspect the offending frame",
    "Add a nil-guard before accessing the failing property",
    "Verify the expected shape of the data returned by the last step",
    "Restart the sub-agent with a clean context if state is corrupted",
  ],
  timeout: [
    "Increase the operation timeout if the task is legitimately long",
    "Break the operation into smaller chunks",
    "Retry once with a doubled timeout limit",
    "Check if the downstream service is experiencing latency",
  ],
  unknown: [
    "Capture and log the raw error for manual inspection",
    "Retry once in case of transient failure",
    "Escalate to the parent agent or human reviewer",
  ],
};

function parseStackFrames(stack: string | undefined): StackFrame[] {
  if (!stack) return [];
  const frameRegex = /at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?/g;
  const frames: StackFrame[] = [];
  let match: RegExpExecArray | null;
  while ((match = frameRegex.exec(stack)) !== null && frames.length < 8) {
    frames.push({
      fn: match[1] ?? null,
      file: match[2] ?? "",
      line: match[3] ? parseInt(match[3], 10) : null,
      column: match[4] ? parseInt(match[4], 10) : null,
    });
  }
  return frames;
}

function detectCategory(message: string): ErrorCategory {
  if (TIMEOUT_PATTERNS.some((p) => p.test(message))) return "timeout";
  if (NETWORK_PATTERNS.some((p) => p.test(message))) return "network";
  if (AUTH_PATTERNS.some((p) => p.test(message))) return "auth";
  if (PERMISSION_PATTERNS.some((p) => p.test(message))) return "permission";
  if (SYNTAX_PATTERNS.some((p) => p.test(message))) return "syntax";
  if (RUNTIME_PATTERNS.some((p) => p.test(message))) return "runtime";
  return "unknown";
}

function severityFor(category: ErrorCategory): ClassifiedError["severity"] {
  switch (category) {
    case "auth":
    case "permission":
      return "high";
    case "syntax":
    case "runtime":
    case "network":
    case "timeout":
      return "medium";
    default:
      return "low";
  }
}

export function classifyError(error: unknown): ClassifiedError {
  const err = error instanceof Error ? error : new Error(String(error));
  const combined = `${err.name ?? ""} ${err.message ?? ""} ${err.stack ?? ""}`;
  const category = detectCategory(combined);

  return {
    category,
    message: err.message,
    originalError: error,
    stackFrames: parseStackFrames(err.stack),
    recoveryActions: RECOVERY[category],
    retryable: category === "network" || category === "timeout",
    severity: severityFor(category),
  };
}
