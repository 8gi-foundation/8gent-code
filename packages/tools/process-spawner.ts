/**
 * process-spawner.ts
 * Spawn and manage child processes with output capture, timeout enforcement,
 * streaming, environment inheritance, and optional shell mode.
 */

export interface SpawnOptions {
  /** Timeout in milliseconds. Kills process on expiry. Default: 30000 */
  timeout?: number;
  /** Working directory for the child process. Defaults to cwd of parent. */
  cwd?: string;
  /** Environment variables merged onto process.env. */
  env?: Record<string, string>;
  /** Inherit parent environment. Default: true */
  inheritEnv?: boolean;
  /** Called with each stdout chunk as it arrives. */
  onStdout?: (chunk: string) => void;
  /** Called with each stderr chunk as it arrives. */
  onStderr?: (chunk: string) => void;
  /** Run via shell (/bin/sh -c). Allows pipes, globs. Default: false */
  shell?: boolean;
  /** Max combined output bytes before truncation. Default: 10MB */
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

/**
 * Spawn a process by executable + args array.
 * Does not invoke a shell unless shell:true is passed.
 */
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
    try { proc.kill(9); } catch { /* already exited */ }
  }, timeout);

  const readStream = async (
    stream: ReadableStream<Uint8Array>,
    onChunk?: (s: string) => void
  ): Promise<string> => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (totalBytes >= maxOutputBytes) continue;
        const chunk = decoder.decode(value, { stream: true });
        buf += chunk;
        totalBytes += value.byteLength;
        onChunk?.(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    return buf;
  };

  const [stdout, stderr] = await Promise.all([
    readStream(proc.stdout, onStdout),
    readStream(proc.stderr, onStderr),
    proc.exited,
  ]);

  clearTimeout(killTimer);
  stdoutBuf = stdout;
  stderrBuf = stderr;

  const exitCode = await proc.exited;
  return {
    exitCode: timedOut ? null : exitCode,
    stdout: stdoutBuf,
    stderr: stderrBuf,
    timedOut,
    durationMs: Date.now() - startMs,
  };
}

/**
 * Execute a shell command string via /bin/sh -c.
 * Prefer spawn() for untrusted input.
 */
export async function exec(
  command: string,
  options: Omit<SpawnOptions, "shell"> = {}
): Promise<SpawnResult> {
  return spawn(command, [], { ...options, shell: true });
}
