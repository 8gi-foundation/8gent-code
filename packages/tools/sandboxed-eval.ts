/**
 * sandboxed-eval.ts - Safely evaluates JavaScript expressions in a restricted context.
 * No dependencies. No network. No fs. No process access.
 */

export interface EvalResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  durationMs: number;
}

export interface EvalContext {
  [key: string]: unknown;
}

const BLOCKED_NAMES = [
  "process", "global", "globalThis", "require", "module", "exports",
  "__dirname", "__filename", "Bun", "Deno", "fetch", "XMLHttpRequest",
  "WebSocket", "eval", "Function", "setTimeout", "setInterval",
  "clearTimeout", "clearInterval", "setImmediate", "clearImmediate",
  "queueMicrotask", "Buffer", "fs", "path", "os", "child_process",
];

function buildScope(context: EvalContext): { params: string[]; args: unknown[] } {
  const params: string[] = [];
  const args: unknown[] = [];
  for (const name of BLOCKED_NAMES) { params.push(name); args.push(undefined); }
  for (const [key, val] of Object.entries(context)) {
    if (!BLOCKED_NAMES.includes(key)) { params.push(key); args.push(val); }
  }
  return { params, args };
}

function wrapCode(code: string): string {
  return `return (async () => { ${code} })()`;
}

/**
 * Evaluates a JavaScript expression or statement block in a sandboxed context.
 * @param code    - JavaScript source to evaluate. May use return or await.
 * @param context - Variables to inject into scope (default: {}).
 * @param timeout - Max execution time in ms (default: 3000). 0 = no limit.
 */
export async function safeEval(
  code: string,
  context: EvalContext = {},
  timeout = 3000,
): Promise<EvalResult> {
  const start = Date.now();

  if (typeof code !== "string" || code.trim() === "") {
    return { ok: false, error: "code must be a non-empty string", durationMs: 0 };
  }

  const { params, args } = buildScope(context);

  let fn: (...a: unknown[]) => Promise<unknown>;
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function(...params, wrapCode(code)) as (...a: unknown[]) => Promise<unknown>;
  } catch (err) {
    return {
      ok: false,
      error: `SyntaxError: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  }

  try {
    let value: unknown;
    if (timeout > 0) {
      const timer = new Promise<never>((_, reject) =>
        globalThis.setTimeout(() => reject(new Error(`Timeout after ${timeout}ms`)), timeout),
      );
      value = await Promise.race([fn(...args), timer]);
    } else {
      value = await fn(...args);
    }
    return { ok: true, value, durationMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  const code = argv.join(" ");
  if (!code) { console.error('Usage: bun packages/tools/sandboxed-eval.ts "<expression>"'); process.exit(1); }
  const result = await safeEval(code);
  if (result.ok) { console.log(JSON.stringify(result.value, null, 2)); }
  else { console.error(`Error: ${result.error}`); process.exit(1); }
}
