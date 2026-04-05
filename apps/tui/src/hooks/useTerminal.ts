/**
 * 8gent Code - Terminal Hook
 *
 * Manages node-pty PTY instances per terminal tab.
 * Each tab gets its own shell process. Output is stored as lines
 * for rendering in TerminalView. Agents write to the PTY via
 * write_terminal tool, which goes through the global TerminalRegistry.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { createRequire } from "module";
import * as os from "os";
import * as path from "path";

// Use createRequire for node-pty — Bun native addon compatibility
const _require = createRequire(import.meta.url);
const pty = _require("node-pty") as typeof import("node-pty");

// Bun's `bun add` doesn't set +x on prebuilt binaries — ensure spawn-helper is executable
try {
  const { chmodSync, existsSync } = _require("fs") as typeof import("fs");
  const nodePtyDir = _require.resolve("node-pty/package.json").replace("/package.json", "");
  const helper = `${nodePtyDir}/prebuilds/${process.platform}-${process.arch}/spawn-helper`;
  if (existsSync(helper)) chmodSync(helper, 0o755);
} catch { /* non-fatal */ }

// Try shells in order until one exists
function resolveShell(): string {
  const { existsSync } = _require("fs") as typeof import("fs");
  const candidates = [
    process.env.SHELL,
    "/bin/zsh",
    "/bin/bash",
    "/bin/sh",
  ].filter(Boolean) as string[];
  for (const s of candidates) {
    try { if (existsSync(s)) return s; } catch {}
  }
  return "/bin/sh";
}
const SHELL = resolveShell();
const MAX_LINES = 1000;

// -------------------------------------------------------
// Global registry: tabId → IPty
// Used by write_terminal tool (outside React lifecycle)
// -------------------------------------------------------

interface PTYEntry {
  pty: pty.IPty;
  outputCallback?: (line: string) => void;
}

const _registry = new Map<string, PTYEntry>();

/** Called by write_terminal tool to send input to a tab's PTY */
export function writeToTerminal(tabId: string, input: string): string {
  const entry = _registry.get(tabId);
  if (!entry) return `No terminal open for tab ${tabId}`;
  entry.pty.write(input.endsWith("\n") ? input : `${input}\n`);
  return `Sent to terminal tab ${tabId}`;
}

/** List open terminal tabs */
export function listTerminals(): string[] {
  return [..._registry.keys()];
}

// -------------------------------------------------------
// Per-tab hook
// -------------------------------------------------------

export interface TerminalState {
  lines: string[];
  isRunning: boolean;
  pid: number | null;
}

/** Strip ANSI escape codes for plain rendering */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[mGKJHFABCDSTu]|\x1B\][^\x07]*\x07|\r/g, "");
}

export function useTerminal(tabId: string, cwd?: string) {
  const [state, setState] = useState<TerminalState>({
    lines: [],
    isRunning: false,
    pid: null,
  });

  const ptyRef = useRef<pty.IPty | null>(null);
  const linesRef = useRef<string[]>([]);
  const pendingRef = useRef<string>(""); // partial line buffer

  const appendOutput = useCallback((data: string) => {
    // Buffer partial lines
    const combined = pendingRef.current + data;
    const parts = combined.split("\n");
    pendingRef.current = parts.pop() ?? "";

    const newLines = parts
      .map(stripAnsi)
      .filter((l) => l.length > 0);

    if (newLines.length === 0) return;

    linesRef.current = [...linesRef.current, ...newLines].slice(-MAX_LINES);
    setState((prev) => ({ ...prev, lines: linesRef.current }));
  }, []);

  // Spawn PTY when tab is first shown
  const spawn = useCallback(() => {
    if (ptyRef.current) return; // already running

    const workDir = cwd || process.cwd();

    let proc: ReturnType<typeof pty.spawn>;
    try {
      proc = pty.spawn(SHELL, [], {
        name: "xterm-256color",
        cols: 120,
        rows: 30,
        cwd: workDir,
        env: { ...process.env } as Record<string, string>,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      linesRef.current = [`[terminal error] ${msg}`, `[shell: ${SHELL}]`, ""];
      setState({ lines: linesRef.current, isRunning: false, pid: null });
      return;
    }

    ptyRef.current = proc;
    linesRef.current = [];

    proc.onData((data) => appendOutput(data));

    proc.onExit(() => {
      _registry.delete(tabId);
      ptyRef.current = null;
      setState({ lines: linesRef.current, isRunning: false, pid: null });
    });

    _registry.set(tabId, { pty: proc });

    setState({ lines: [], isRunning: true, pid: proc.pid });
  }, [tabId, cwd, appendOutput]);

  // Spawn on mount, kill on unmount
  useEffect(() => {
    spawn();
    return () => {
      if (ptyRef.current) {
        _registry.delete(tabId);
        try { ptyRef.current.kill(); } catch { /* already dead */ }
        ptyRef.current = null;
      }
    };
  }, [tabId, spawn]);

  /** Write a command to the terminal (user-typed or agent-sent) */
  const write = useCallback((input: string) => {
    if (!ptyRef.current) return;
    ptyRef.current.write(input.endsWith("\n") ? input : `${input}\n`);
  }, []);

  /** Resize the PTY when terminal dimensions change */
  const resize = useCallback((cols: number, rows: number) => {
    if (!ptyRef.current) return;
    try { ptyRef.current.resize(cols, rows); } catch { /* ignore */ }
  }, []);

  /** Kill and restart the shell */
  const restart = useCallback(() => {
    if (ptyRef.current) {
      _registry.delete(tabId);
      try { ptyRef.current.kill(); } catch { /* ignore */ }
      ptyRef.current = null;
    }
    linesRef.current = [];
    pendingRef.current = "";
    setState({ lines: [], isRunning: false, pid: null });
    // Re-spawn on next render cycle
    setTimeout(spawn, 50);
  }, [tabId, spawn]);

  return { ...state, write, resize, restart };
}
