/**
 * process-spawner.ts
 * Spawn and manage child processes with output capture, timeout enforcement,
 * streaming, environment inheritance, and optional shell mode.
 */

export interface SpawnOptions {
  /** Timeout in ms. Process is killed on expiry. Default: 30000 */
  timeout?: number;
  /** Working directory for the subprocess. */
  cwd?: string;
  /** Env vars merged onto process.env (or used alone when inheritEnv=false). */
  env?: Record<string, string>;
  /** Inherit parent environment. Default: true */
  inheritEnv?: boolean;
  /** Callback fired with each stdout chunk. */
  onStdout?: (chunk: string) => void;
  /** Callback fired with each stderr chunk. */
  onStderr?: (chunk: string) => void;
  /** Run via /bin/sh -c (enables pipes, globs). Default: false */
  shell?: boolean;
  /** Max combined output bytes. Extra output is drained and discarded. Default: 10MB */
  maxOutputBytes?: number;
}

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_OUTPUT = 10 * 1024 * 1024;

export async function spawn(
  cmd: string,
  args: string[] = [],
  options: SpawnOptions = {}
): Promise<SpawnResult> {
  const {
    timeout = DEFAULT_TIMEOUT,
    cwd = process.cwd(),
    env: extraEnv = {},
    inheritEnv = true,
    onStdout,
    onStderr,
    shell = false,
    maxOutputBytes = DEFAULT_MAX_OUTPUT,
  } = options;

  const env: Record<string, string> = inheritEnv
    ? { ...(process.env as Record<string, string>), ...extraEnv }
    : { ...extraEnv };

  const finalCmd = shell ? "/bin/sh" : cmd;
  const finalArgs = shell ? ["-c", [cmd, ...args].join(" ")] : args;

  const proc = Bun.spawn([finalCmd, ...finalArgs], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  let totalBytes = 0;
  let timedOut = false;
  const startMs = Date.now();

  const killTimer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(9); } catch { /* already dead */ }
  }, timeout);

  async function drain(
    stream: ReadableStream<Uint8Array>,
    onChunk?: (s: string) => void
  ): Promise<string> {
    const dec = new TextDecoder();
    const reader = stream.getReader();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (totalBytes < maxOutputBytes) {
          const chunk = dec.decode(value, { stream: true });
          buf += chunk;
          totalBytes += value.byteLength;
          onChunk?.(chunk);
        }
      }
    } finally {
      reader.releaseLock();
    }
    return buf;
  }

  const [stdout, stderr] = await Promise.all([
    drain(proc.stdout, onStdout),
    drain(proc.stderr, onStderr),
    proc.exited,
  ]);

  clearTimeout(killTimer);
  stdoutBuf = stdout;
  stderrBuf = stderr;

  return {
    exitCode: timedOut ? null : await proc.exited,
    stdout: stdoutBuf,
    stderr: stderrBuf,
    timedOut,
    durationMs: Date.now() - startMs,
  };
}

/** Run a shell command string. Prefer spawn() for untrusted input. */
export async function exec(
  command: string,
  options: Omit<SpawnOptions, "shell"> = {}
): Promise<SpawnResult> {
  return spawn(command, [], { ...options, shell: true });
}
