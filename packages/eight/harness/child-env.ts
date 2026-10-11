/**
 * Minimal environment for commands the model runs.
 *
 * A child shell gets a short allowlist of ordinary process settings, not a copy
 * of the parent's environment. Anything else is passed only by name through
 * EIGHT_SHELL_ENV_PASS, a deliberate per-session choice. Tools that need a
 * credential read it in-process from the parent, not through a shell.
 *
 * EIGHT_SHELL_ENV_INHERIT=1 restores the old full-inherit behaviour as a
 * temporary escape hatch.
 */

type Env = Record<string, string | undefined>;

/** Exact names (compared upper-case, so Windows casing works). */
const BASE_NAMES = new Set([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"TERM",
	"TMPDIR",
	"TZ",
	"PWD",
	"CI",
	"NO_COLOR",
	"COLORTERM",
	"EIGHT_HEADLESS",
	// Windows: cmd.exe and most tools fail to start without these.
	"COMSPEC",
	"SYSTEMROOT",
	"WINDIR",
	"PATHEXT",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"TEMP",
	"TMP",
	"SYSTEMDRIVE",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PROGRAMDATA",
]);

const isBase = (name: string): boolean => {
	const upper = name.toUpperCase();
	return BASE_NAMES.has(upper) || upper.startsWith("LC_");
};

/** Names listed in EIGHT_SHELL_ENV_PASS ("A,B C"), trimmed, empties dropped. */
export function envPassList(source: Env = process.env): string[] {
	return (source.EIGHT_SHELL_ENV_PASS ?? "")
		.split(/[,\s]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Build the environment for a child process.
 * @param source  environment to read from (defaults to process.env)
 * @param extraNames  extra exact names allowed for this call site only
 * @param extraPrefixes  extra name prefixes allowed for this call site only (e.g. "GIT_")
 */
export function buildChildEnv(
	source: Env = process.env,
	extraNames: readonly string[] = [],
	extraPrefixes: readonly string[] = [],
): Record<string, string> {
	if (source.EIGHT_SHELL_ENV_INHERIT === "1") {
		const all: Record<string, string> = {};
		for (const [k, v] of Object.entries(source)) if (v !== undefined) all[k] = v;
		return all;
	}
	const names = new Set([...extraNames, ...envPassList(source)].map((n) => n.toUpperCase()));
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(source)) {
		if (v === undefined) continue;
		const upper = k.toUpperCase();
		if (
			isBase(k) ||
			names.has(upper) ||
			extraPrefixes.some((p) => upper.startsWith(p.toUpperCase()))
		) {
			out[k] = v;
		}
	}
	return out;
}
