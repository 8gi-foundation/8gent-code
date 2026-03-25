import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { chmod } from "fs/promises";
import { join } from "path";
import { spawnSync } from "child_process";

export type HookType =
  | "pre-commit"
  | "pre-push"
  | "commit-msg"
  | "prepare-commit-msg"
  | "post-commit"
  | "post-merge"
  | "pre-rebase";

export interface HookInfo {
  name: HookType;
  path: string;
  installed: boolean;
  content?: string;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const SHEBANG = "#!/bin/sh\n";

export class GitHooks {
  private hooksDir: string;

  constructor(repoRoot: string = process.cwd()) {
    this.hooksDir = join(repoRoot, ".git", "hooks");
  }

  private hookPath(name: HookType): string {
    return join(this.hooksDir, name);
  }

  private ensureHooksDir(): void {
    if (!existsSync(this.hooksDir)) {
      mkdirSync(this.hooksDir, { recursive: true });
    }
  }

  /** Install a hook with the given script body. Overwrites if present. */
  async install(name: HookType, script: string): Promise<void> {
    this.ensureHooksDir();
    const content = script.startsWith("#!") ? script : `${SHEBANG}${script}\n`;
    writeFileSync(this.hookPath(name), content, "utf-8");
    await chmod(this.hookPath(name), 0o755);
  }

  /** Remove an installed hook. No-op if not present. */
  remove(name: HookType): boolean {
    const path = this.hookPath(name);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
  }

  /** List all hooks - installed status and content for installed ones. */
  list(): HookInfo[] {
    const all: HookType[] = [
      "pre-commit",
      "pre-push",
      "commit-msg",
      "prepare-commit-msg",
      "post-commit",
      "post-merge",
      "pre-rebase",
    ];
    return all.map((name) => {
      const path = this.hookPath(name);
      const installed = existsSync(path);
      return {
        name,
        path,
        installed,
        content: installed ? readFileSync(path, "utf-8") : undefined,
      };
    });
  }

  /** List only installed hooks. */
  listInstalled(): HookInfo[] {
    return this.list().filter((h) => h.installed);
  }

  /** Run a hook directly (bypassing git). Returns exit code + output. */
  run(name: HookType, args: string[] = [], env?: NodeJS.ProcessEnv): RunResult {
    const path = this.hookPath(name);
    if (!existsSync(path)) {
      return { exitCode: 1, stdout: "", stderr: `Hook '${name}' is not installed` };
    }
    const result = spawnSync(path, args, {
      env: { ...process.env, ...env },
      encoding: "utf-8",
    });
    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  /**
   * Chain multiple scripts under a single hook.
   * Each script runs in order; if any fails the chain stops (exit 1).
   */
  async chain(name: HookType, scripts: string[]): Promise<void> {
    if (scripts.length === 0) return;
    const body = scripts
      .map((s, i) => {
        const trimmed = s.trim().replace(/^#!.*\n/, "");
        return `# --- step ${i + 1} ---\n${trimmed}`;
      })
      .join("\n\n");
    const script = `${SHEBANG}\nset -e\n\n${body}\n`;
    await this.install(name, script);
  }

  /** Check whether a specific hook is installed. */
  isInstalled(name: HookType): boolean {
    return existsSync(this.hookPath(name));
  }

  /** Read raw content of an installed hook. Returns null if not found. */
  read(name: HookType): string | null {
    const path = this.hookPath(name);
    return existsSync(path) ? readFileSync(path, "utf-8") : null;
  }
}
