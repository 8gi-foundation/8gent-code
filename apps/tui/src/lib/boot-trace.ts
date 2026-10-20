/**
 * Boot trace (#4540): one line per startup stage in ~/.8gent/logs/tui-boot.log,
 * so a TUI that stops at its first screen on a machine we cannot see leaves a
 * record of the last stage it reached. Always on; EIGHT_BOOT_TRACE=0 disables.
 * Never throws and never touches stdout. The file is capped at 256 KB by
 * keeping its last half.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const BOOT_TRACE_MAX_BYTES = 256 * 1024;

const t0 = performance.now();

export function bootTracePath(home: string = os.homedir()): string {
	return path.join(home, ".8gent", "logs", "tui-boot.log");
}

/** Append `stage` (and optional detail) with a monotonic ms offset. Returns true when written. */
export function bootTrace(
	stage: string,
	detail?: string,
	opts: { file?: string; env?: Record<string, string | undefined>; now?: () => number } = {},
): boolean {
	try {
		const env = opts.env ?? process.env;
		if (env.EIGHT_BOOT_TRACE === "0") return false;
		// Unit tests must not write the real home log; an explicit file still does.
		if (!opts.file && env.NODE_ENV === "test") return false;
		const file = opts.file ?? bootTracePath();
		const ms = Math.round(((opts.now ?? (() => performance.now()))() - t0) * 10) / 10;
		const line = `${new Date().toISOString()} +${ms}ms pid=${process.pid} ${stage}${detail ? ` ${detail}` : ""}\n`;
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, line);
		capFile(file);
		return true;
	} catch {
		return false;
	}
}

function capFile(file: string): void {
	try {
		const size = fs.statSync(file).size;
		if (size <= BOOT_TRACE_MAX_BYTES) return;
		const buf = fs.readFileSync(file);
		let tail = buf.subarray(buf.length - Math.floor(BOOT_TRACE_MAX_BYTES / 2));
		const nl = tail.indexOf(10);
		if (nl >= 0) tail = tail.subarray(nl + 1); // start on a whole line
		fs.writeFileSync(file, tail);
	} catch {
		/* best effort */
	}
}

/** Environment facts worth having in every trace. */
export function bootEnvSummary(): string {
	const e = process.env;
	const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: unknown };
	const bun = (process.versions as Record<string, string | undefined>).bun ?? "none";
	return [
		`platform=${process.platform}`,
		`arch=${process.arch}`,
		`bun=${bun}`,
		`TERM=${e.TERM ?? ""}`,
		`WT_SESSION=${e.WT_SESSION ? "set" : ""}`,
		`TERM_PROGRAM=${e.TERM_PROGRAM ?? ""}`,
		`stdin.isTTY=${Boolean(stdin.isTTY)}`,
		`stdout.isTTY=${Boolean(process.stdout.isTTY)}`,
		`rawModeSupported=${typeof stdin.setRawMode === "function"}`,
		`cols=${process.stdout.columns ?? 0}`,
		`rows=${process.stdout.rows ?? 0}`,
	].join(" ");
}

/** The last `n` lines of the trace, for `8gent doctor`. Empty when there is none. */
export function readBootTraceTail(n = 30, file: string = bootTracePath()): string[] {
	try {
		const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
		return lines.slice(-n);
	} catch {
		return [];
	}
}
