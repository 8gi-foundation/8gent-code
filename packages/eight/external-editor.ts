/**
 * External editor (Pi parity row D6, module side).
 *
 * openInExternalEditor(text) writes the text to a temp file, runs the person's
 * editor on it and returns the edited text, or null if the editor could not be
 * run or exited non-zero. The caller (TUI) must release the terminal first
 * (stop Ink raw mode) and restore it after; this module only spawns.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Split a command line into argv without a shell. Honors "double" and 'single' quotes and backslash escapes outside single quotes. */
export function splitCommand(cmd: string): string[] {
	const out: string[] = [];
	let cur = "";
	let has = false;
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < cmd.length; i++) {
		const c = cmd[i];
		if (quote) {
			if (c === quote) quote = null;
			else if (c === "\\" && quote === '"' && (cmd[i + 1] === '"' || cmd[i + 1] === "\\")) cur += cmd[++i];
			else cur += c;
		} else if (c === '"' || c === "'") {
			quote = c;
			has = true;
		} else if (/\s/.test(c)) {
			if (has || cur) out.push(cur);
			cur = "";
			has = false;
		} else {
			cur += c;
			has = true;
		}
	}
	if (has || cur) out.push(cur);
	return out;
}

/** $VISUAL, then $EDITOR, then notepad on win32 and vi elsewhere. */
export function resolveEditorCommand(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string[] {
	const raw = env.VISUAL?.trim() || env.EDITOR?.trim() || (platform === "win32" ? "notepad" : "vi");
	const argv = splitCommand(raw);
	return argv.length ? argv : [platform === "win32" ? "notepad" : "vi"];
}

export function openInExternalEditor(
	initialText: string,
	opts: { env?: NodeJS.ProcessEnv; platform?: string } = {},
): string | null {
	const [cmd, ...args] = resolveEditorCommand(opts.env ?? process.env, opts.platform ?? process.platform);
	let dir: string | null = null;
	try {
		dir = mkdtempSync(join(tmpdir(), "8gent-edit-"));
		const file = join(dir, "message.md");
		writeFileSync(file, initialText, { mode: 0o600 });
		const r = spawnSync(cmd, [...args, file], { stdio: "inherit", shell: false, env: opts.env ?? process.env });
		if (r.error || r.status !== 0) return null;
		return readFileSync(file, "utf8").replace(/\n$/, "");
	} catch {
		return null;
	} finally {
		if (dir) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {}
		}
	}
}
