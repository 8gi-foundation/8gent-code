/**
 * Subprocess Sandbox - environment stripping and optional Docker isolation.
 *
 * Strips environment variables to an allowlist before spawning subprocesses.
 * Optionally uses Docker for full filesystem/network isolation.
 */

import { EventEmitter } from 'node:events';

export interface SandboxOptions {
  useDocker: boolean;
  containerImage: string;
  workspacePath: string;
  timeout: number;
  envAllowlist: string[];
}

const DEFAULT_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'NODE_PATH',
  'DISPLAY',
  'XDG_RUNTIME_DIR',
  'TERM',
  'LANG',
  'LC_ALL',
  'USER',
  'SHELL',
  'TMPDIR',
  'BUN_INSTALL',
];

const DEFAULT_OPTIONS: SandboxOptions = {
  useDocker: false,
  containerImage: '8gent-sandbox:latest',
  workspacePath: process.cwd(),
  timeout: 30_000,
  envAllowlist: DEFAULT_ENV_ALLOWLIST,
};

function stripEnv(allowlist: string[]): Record<string, string> {
  const stripped: Record<string, string> = {};
  for (const key of allowlist) {
    const val = process.env[key];
    if (val !== undefined) {
      stripped[key] = val;
    }
  }
  return stripped;
}

export class SubprocessSandbox extends EventEmitter {
  private options: SandboxOptions;
  private containerId: string | null = null;

  constructor(options?: Partial<SandboxOptions>) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Execute a command in the sandbox.
   * Uses Docker if available and configured, otherwise Bun.spawn with stripped env.
   */
  async exec(
    command: string,
    args: string[] = [],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (this.options.useDocker) {
      return this.execDocker(command, args);
    }
    return this.execLocal(command, args);
  }

  private async execLocal(
    command: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const env = stripEnv(this.options.envAllowlist);

    this.emit('sandbox:exec', { command, args, mode: 'local' });

    const proc = Bun.spawn([command, ...args], {
      env,
      cwd: this.options.workspacePath,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const timeout = setTimeout(() => {
      proc.kill();
      this.emit('sandbox:timeout', { command, timeout: this.options.timeout });
    }, this.options.timeout);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    clearTimeout(timeout);

    this.emit('sandbox:complete', { command, exitCode });
    return { stdout, stderr, exitCode };
  }

  private async execDocker(
    command: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // Ensure container is running
    if (!this.containerId) {
      await this.createContainer();
    }

    const dockerArgs = [
      'exec',
      this.containerId!,
      command,
      ...args,
    ];

    this.emit('sandbox:exec', { command, args, mode: 'docker' });

    const proc = Bun.spawn(['docker', ...dockerArgs], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const timeout = setTimeout(() => {
      proc.kill();
      this.emit('sandbox:timeout', { command, timeout: this.options.timeout });
    }, this.options.timeout);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    clearTimeout(timeout);

    this.emit('sandbox:complete', { command, exitCode, mode: 'docker' });
    return { stdout, stderr, exitCode };
  }

  private async createContainer(): Promise<void> {
    const proc = Bun.spawn([
      'docker', 'run', '-d',
      '--name', `8gent-sandbox-${Date.now()}`,
      '--user', 'sandbox',
      '-v', `${this.options.workspacePath}:/workspace:rw`,
      '-v', '/tmp:/tmp:ro',
      '--read-only',
      '--tmpfs', '/run',
      '--tmpfs', '/home/sandbox',
      '--network', 'none',
      this.options.containerImage,
      'sleep', 'infinity',
    ], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      this.emit('sandbox:error', { error: `Failed to create container: ${stderr}` });
      throw new Error(`Docker container creation failed: ${stderr}`);
    }

    this.containerId = stdout.trim();
    this.emit('sandbox:container-created', { containerId: this.containerId });
  }

  async cleanup(): Promise<void> {
    if (!this.containerId) return;

    try {
      const stop = Bun.spawn(['docker', 'stop', this.containerId], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await stop.exited;

      const rm = Bun.spawn(['docker', 'rm', this.containerId], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await rm.exited;

      this.emit('sandbox:cleanup', { containerId: this.containerId });
    } catch {
      // Best-effort cleanup
    }

    this.containerId = null;
  }

  /**
   * Check if Docker is available on this system.
   */
  static async isDockerAvailable(): Promise<boolean> {
    try {
      const proc = Bun.spawn(['docker', 'info'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  getStrippedEnv(): Record<string, string> {
    return stripEnv(this.options.envAllowlist);
  }
}
