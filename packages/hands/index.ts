// @8gent/hands - v0 wrapper around the locally-installed cua-driver binary.
//
// Status: shells out to `/usr/local/bin/cua-driver` (v0.0.4) and exposes a
// typed callTool() the rest of 8gent-code can use. Eventually this package
// becomes the embedded fork (see PRD #1746). Today it is a thin adapter so
// the 8gent Computer Mac app can ship.
//
// The fork rename ("8gent-hands") happens later - internal code still uses
// "cua-driver" because that is the binary name on James's machine.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import type { HandsDriver } from "./types.ts";
export type { PlannedStep, StepResult, RunResult } from "./types.ts";
export { STUB_TOOLS } from "./types.ts";

const CUA_DRIVER_BIN =
  process.env.HANDS_BIN ?? "/usr/local/bin/cua-driver";

export interface CallOptions {
  /** Write the first image content block to this path. */
  imageOut?: string;
  /** Print the raw CallTool.Result JSON. */
  raw?: boolean;
  /** Bypass the long-running daemon. */
  noDaemon?: boolean;
  /** Hard timeout in ms. Default 30s. */
  timeoutMs?: number;
}

export interface CallResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  imagePath?: string;
  exitCode: number | null;
  durationMs: number;
}

export class HandsError extends Error {
  constructor(
    message: string,
    public readonly stderr: string = "",
    public readonly exitCode: number | null = null,
  ) {
    super(message);
    this.name = "HandsError";
  }
}

/**
 * Invoke a single cua-driver tool. Mirrors `cua-driver call <name> <json>`.
 *
 * Throws HandsError if the binary is missing. Returns CallResult either way
 * for callable failures so the caller can decide how to surface them.
 */
export async function callTool(
  toolName: string,
  args: Record<string, unknown> = {},
  opts: CallOptions = {},
): Promise<CallResult> {
  if (!existsSync(CUA_DRIVER_BIN)) {
    throw new HandsError(
      `cua-driver not found at ${CUA_DRIVER_BIN}. Install CuaDriver.app or set HANDS_BIN.`,
    );
  }

  const cliArgs: string[] = ["call", toolName];
  if (Object.keys(args).length > 0) {
    cliArgs.push(JSON.stringify(args));
  }
  if (opts.imageOut) {
    cliArgs.push("--image-out", opts.imageOut);
  }
  if (opts.raw) cliArgs.push("--raw");
  if (opts.noDaemon) cliArgs.push("--no-daemon");

  const startedAt = Date.now();
  const result = await new Promise<CallResult>((resolve) => {
    const child = spawn(CUA_DRIVER_BIN, cliArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, opts.timeoutMs ?? 30_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const ok = !timedOut && code === 0;
      resolve({
        ok,
        stdout: stdout.trim(),
        stderr: stderr.trim() + (timedOut ? "\n[hands] timed out" : ""),
        imagePath: opts.imageOut && existsSync(opts.imageOut) ? opts.imageOut : undefined,
        exitCode: code,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        stdout: "",
        stderr: `[hands] spawn error: ${err.message}`,
        exitCode: null,
        durationMs: Date.now() - startedAt,
      });
    });
  });

  return result;
}

/** Identity for any consumer that takes a HandsDriver type import. */
export const driver: HandsDriver = {
  id: "hands-macos-cua-v0",
};

export const HANDS_PLACEHOLDER = false as const;
