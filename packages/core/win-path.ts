/**
 * 8gent - Windows long-path (extended-length) helpers.
 *
 * Windows caps ordinary ("DOS") paths at MAX_PATH = 260 characters. Anything
 * longer must reach the Win32 file APIs in the verbatim namespace with the
 * `\\?\` extended-length marker (`\\?\UNC\server\share` for network paths).
 * See: https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation
 *
 * Failure modes this module fixes, and the ones it deliberately does not touch:
 *
 *   0x80070002 = HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)
 *     Process creation fails for an overlong *working directory* (and for a
 *     relative executable resolved against one) even though the file exists,
 *     because the Win32 path layer cannot resolve >MAX_PATH without the marker.
 *     Measured: `spawn(node, ["script.mjs"], { cwd: <313-char dir> })` → ENOENT
 *     (Win32 2); the same call with the cwd marked → exit 0. This is the fix.
 *
 *   0x8007007B = HRESULT_FROM_WIN32(ERROR_INVALID_NAME)
 *     The marker reached a consumer that only accepts DOS paths. `\\?\` is a
 *     file-system namespace directive (verbatim: absolute-only, backslash-only,
 *     no `.`/`..`), and it is not valid input for the process-name/path-parsing
 *     stage - the module-name token of a command line is capped at MAX_PATH when
 *     lpApplicationName is NULL. This is why the executable token and command-line
 *     arguments are NEVER rewritten here.
 *
 * Why arguments are left alone (measured, Windows 11 26200 / bun 1.4.2 / node 22):
 *   - node child + plain 326-char script operand → runs; + verbatim operand → exit 1
 *     (`node:fs` resolution rejects the marked path in argv).
 *   - bun child  + either form → runs.
 *   - git: `git add \\?\C:\...` → `fatal: Invalid path '//?/C:/...'` - git rewrites
 *     the marker and rejects it; `git worktree add \\?\C:\...` → "could not create
 *     leading directories ... Invalid argument".
 *   - a marked token inside a shell command string is not parseable by cmd.exe.
 *   Long-path-aware children resolve their own operands, so marking them buys
 *   nothing and breaks several real children. Only the cwd is rewritten.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import path from "node:path";

/**
 * Rewrite threshold. MAX_PATH is 260 including the terminating NUL, so a path of
 * 260 chars is already unusable as a directory name (a child name needs room) and
 * the extended marker itself costs 4 (`\\?\`) or 8 (`\\?\UNC\`) characters.
 * 240 leaves realistic headroom while keeping ordinary short paths untouched.
 */
const MAX = 240;

/** `\\?\` - verbatim local path marker. Source literal: four backslashes, `?`, backslash. */
const EXTENDED = "\\\\?\\";
/** `\\?\UNC\` - verbatim UNC marker. */
const EXTENDED_UNC = "\\\\?\\UNC\\";
/** `\\.\` - verbatim device namespace; must not be re-prefixed either. */
const DEVICE = "\\\\.\\";

/**
 * Prefix long absolute paths with the Win32 extended-length marker. No-op off win32.
 *
 * Idempotent: an already-extended path is returned unchanged. Short paths,
 * relative paths and device paths are returned byte-for-byte unchanged (callers
 * compare and display these strings), so this may be applied defensively to any
 * path that reaches a file API - including paths passed to fs, not just spawn.
 */
export function toLongPath(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return p;
  if (p.startsWith(EXTENDED) || p.startsWith(DEVICE)) return p;
  if (!path.win32.isAbsolute(p)) return p;
  if (p.length < MAX) return p;
  // Verbatim namespace rules: separators must be backslashes - a marked path that
  // still contains "/" is rejected with ERROR_INVALID_NAME (0x8007007B).
  const verbatim = p.replace(/\//g, "\\");
  if (verbatim.startsWith("\\\\")) return EXTENDED_UNC + verbatim.slice(2);
  return EXTENDED + verbatim;
}

/**
 * Inverse of toLongPath: drop the `\\?\` marker so the path compares equal to
 * its DOS form (`\\?\UNC\server\share` becomes `\\server\share`). No-op off win32
 * and for paths without the marker.
 */
export function fromLongPath(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return p;
  if (p.startsWith(EXTENDED_UNC)) return `\\\\${p.slice(EXTENDED_UNC.length)}`;
  if (p.startsWith(EXTENDED)) return p.slice(EXTENDED.length);
  return p;
}

/**
 * spawn() with a long-path-safe working directory.
 *
 * The executable token is NOT prefixed (CreateProcess rejects a marked
 * application name - 0x8007007B) and neither are the arguments (see the module
 * header: marking argv breaks node's loader and git's path parsing, and
 * long-path-aware children do not need it).
 *
 * Use this instead of `spawn` for every child whose cwd comes from user or
 * configuration input: a >260-char working directory fails process creation with
 * 0x80070002 under libuv before the executable is even reached.
 */
export function spawnSafe(cmd: string, args: string[], opts?: SpawnOptions): ChildProcess {
  const safeOpts: SpawnOptions = opts?.cwd ? { ...opts, cwd: toLongPath(String(opts.cwd)) } : (opts ?? {});
  return spawn(cmd, args, safeOpts);
}
