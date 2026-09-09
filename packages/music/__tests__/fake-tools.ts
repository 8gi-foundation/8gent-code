/**
 * Fake audio toolchain for the packages/music guardrail tests.
 *
 * The music modules shell out to sox, soxi, ffmpeg, mpv, yt-dlp, afplay and
 * osascript by name (or by the path `command -v` returns). Instead of mocking
 * node:child_process (Bun shares the module cache across test files, so a
 * module mock leaks into every later suite), we put small shell scripts with
 * those names on an isolated PATH. Each script appends its name and argv to a
 * log file and exits. Nothing touches an audio device, mpv, yt-dlp, the
 * network or the developer's real tools.
 *
 * Per-tool behaviour, controlled through environment variables the child
 * inherits from process.env:
 *   sox      creates every argument ending in .wav that does not exist yet
 *            (SoxSynth moves and removes its own intermediates without a
 *            try/catch, so outputs must exist); exit code FAKE_SOX_EXIT
 *   soxi     prints FAKE_SOXI_DURATION (default 4.0)
 *   ffmpeg   cats FAKE_FFMPEG_STDOUT_FILE when set; exit code FAKE_FFMPEG_EXIT
 *   yt-dlp   cats FAKE_YTDLP_STDOUT_FILE when set; exit code FAKE_YTDLP_EXIT
 *   mpv, afplay, osascript   log and exit 0
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FAKE_TOOL_NAMES = [
	"sox",
	"soxi",
	"ffmpeg",
	"mpv",
	"yt-dlp",
	"afplay",
	"osascript",
] as const;
export type FakeToolName = (typeof FAKE_TOOL_NAMES)[number];

// Argv is joined with the ASCII unit separator (octal 037): arguments may
// legitimately contain spaces and tabs (yt-dlp's --print template does).
const SEP = "\u001f";

const LOG_PRELUDE = `#!/bin/sh
# Test double: records argv, never touches audio or the network.
name=$(basename "$0")
{
	printf '%s' "$name"
	for a in "$@"; do printf '\\037%s' "$a"; done
	printf '\\n'
} >> "$FAKE_TOOL_LOG"
`;

const TOOL_BODIES: Record<FakeToolName, string> = {
	sox: `for a in "$@"; do
	case "$a" in
		*.wav) [ -e "$a" ] || : > "$a" ;;
	esac
done
exit "\${FAKE_SOX_EXIT:-0}"
`,
	soxi: `printf '%s\\n' "\${FAKE_SOXI_DURATION:-4.0}"
exit 0
`,
	ffmpeg: `[ -n "$FAKE_FFMPEG_STDOUT_FILE" ] && cat "$FAKE_FFMPEG_STDOUT_FILE"
exit "\${FAKE_FFMPEG_EXIT:-0}"
`,
	"yt-dlp": `[ -n "$FAKE_YTDLP_STDOUT_FILE" ] && cat "$FAKE_YTDLP_STDOUT_FILE"
exit "\${FAKE_YTDLP_EXIT:-0}"
`,
	mpv: "exit 0\n",
	afplay: "exit 0\n",
	osascript: "exit 0\n",
};

/** One recorded invocation: tool name plus its argv. */
export interface RecordedCall {
	tool: string;
	args: string[];
}

export interface FakeTools {
	/** Temp root for this fixture (fake bin, log, scratch files). */
	root: string;
	/** Directory holding the fake executables. */
	bin: string;
	/** A scratch directory inside root for test inputs and outputs. */
	scratch: string;
	/** All calls recorded since the last reset(), in order. */
	calls(): RecordedCall[];
	/** Calls for a single tool. */
	callsFor(tool: FakeToolName): RecordedCall[];
	/** Truncate the log. */
	reset(): void;
	/** Set a per-tool control variable for the rest of the fixture. */
	setEnv(key: string, value: string | undefined): void;
	/** Write a file into scratch and return its path. */
	file(name: string, content?: string): string;
	/** Restore PATH and env, remove the temp root. */
	restore(): void;
}

/**
 * Install the fake toolchain: writes the scripts, prepends the fake bin to an
 * otherwise minimal PATH (/usr/bin:/bin so cp, mv, rm, grep and head still
 * work) and returns handles for reading the log.
 *
 * Call in beforeAll, and call restore() in afterAll.
 */
export function installFakeTools(prefix = "8gent-music-test-"): FakeTools {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const bin = join(root, "bin");
	const scratch = join(root, "scratch");
	const log = join(root, "calls.log");
	mkdirSync(bin, { recursive: true });
	mkdirSync(scratch, { recursive: true });
	writeFileSync(log, "");

	for (const name of FAKE_TOOL_NAMES) {
		const path = join(bin, name);
		writeFileSync(path, LOG_PRELUDE + TOOL_BODIES[name]);
		chmodSync(path, 0o755);
	}

	const savedEnv = new Map<string, string | undefined>();
	const setEnv = (key: string, value: string | undefined) => {
		if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	};

	setEnv("PATH", `${bin}:/usr/bin:/bin`);
	setEnv("FAKE_TOOL_LOG", log);
	for (const key of [
		"FAKE_SOX_EXIT",
		"FAKE_SOXI_DURATION",
		"FAKE_FFMPEG_STDOUT_FILE",
		"FAKE_FFMPEG_EXIT",
		"FAKE_YTDLP_STDOUT_FILE",
		"FAKE_YTDLP_EXIT",
	]) {
		setEnv(key, undefined);
	}

	const calls = (): RecordedCall[] => {
		if (!existsSync(log)) return [];
		return readFileSync(log, "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [tool, ...args] = line.split(SEP);
				return { tool, args };
			});
	};

	return {
		root,
		bin,
		scratch,
		calls,
		callsFor: (tool) => calls().filter((c) => c.tool === tool),
		reset: () => writeFileSync(log, ""),
		setEnv,
		file: (name, content = "") => {
			const path = join(scratch, name);
			writeFileSync(path, content);
			return path;
		},
		restore: () => {
			for (const [key, value] of savedEnv) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** Join argv back into the single effects string the module built. */
export function argsAfter(call: RecordedCall, index: number): string {
	return call.args.slice(index).join(" ");
}

/** Pull the numeric value that follows a flag or effect name in argv. */
export function numberAfter(call: RecordedCall, token: string): number {
	const i = call.args.indexOf(token);
	if (i === -1 || i + 1 >= call.args.length) return Number.NaN;
	return Number.parseFloat(call.args[i + 1]);
}
