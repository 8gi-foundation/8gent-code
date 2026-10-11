/**
 * Minimal environment for commands the model runs.
 *
 * A child shell gets a short allowlist of ordinary process settings, not a copy
 * of the parent's environment. Anything else is passed only by name through
 * EIGHT_SHELL_ENV_PASS, a deliberate per-session choice. Tools that need a
 * credential read it in-process from the parent, not through a shell.
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
 */
export function buildChildEnv(
	source: Env = process.env,
	extraNames: readonly string[] = [],
): Record<string, string> {
	const names = new Set([...extraNames, ...envPassList(source)].map((n) => n.toUpperCase()));
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(source)) {
		if (v === undefined) continue;
		const upper = k.toUpperCase();
		if (isBase(k) || names.has(upper)) out[k] = v;
	}
	return out;
}

/** Git identity and prompt settings the git helper may keep. Not GIT_CONFIG_*, GIT_EXEC_PATH, GIT_PROXY_COMMAND and the like. */
export const GIT_ENV_NAMES = [
	"SSH_AUTH_SOCK",
	"GIT_AUTHOR_NAME",
	"GIT_AUTHOR_EMAIL",
	"GIT_AUTHOR_DATE",
	"GIT_COMMITTER_NAME",
	"GIT_COMMITTER_EMAIL",
	"GIT_COMMITTER_DATE",
	"GIT_TERMINAL_PROMPT",
] as const;

/** Names the gh CLI reads for authentication. Used only on the gh path. */
export const GH_ENV_NAMES = ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_ENTERPRISE_TOKEN"] as const;
