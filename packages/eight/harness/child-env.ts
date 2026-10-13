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
export const BASE_NAMES = new Set([
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
	// Path and mode values for toolchains. Not credentials.
	"VIRTUAL_ENV",
	"CONDA_PREFIX",
	"CONDA_DEFAULT_ENV",
	"PYTHONPATH",
	"JAVA_HOME",
	"ANDROID_HOME",
	"ANDROID_SDK_ROOT",
	"NODE_ENV",
	"NVM_DIR",
	"VOLTA_HOME",
	"PNPM_HOME",
	"BUN_INSTALL",
	"KUBECONFIG",
	"SSL_CERT_FILE",
	"NODE_EXTRA_CA_CERTS",
	"REQUESTS_CA_BUNDLE",
	"CURL_CA_BUNDLE",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"XDG_STATE_HOME",
	"XDG_RUNTIME_DIR",
	"XDG_CONFIG_DIRS",
	"XDG_DATA_DIRS",
	"SSL_CERT_DIR",
	"PYENV_ROOT",
	"ASDF_DIR",
	"ASDF_DATA_DIR",
	"GOPATH",
	"GOROOT",
	"CARGO_HOME",
	"RUSTUP_HOME",
	"DISPLAY",
	"WAYLAND_DISPLAY",
	"EDITOR",
]);

/** Proxy and docker-host settings: passed by default only when the value carries no user:pass@. */
const PROXY_NAMES = new Set(["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "DOCKER_HOST"]);

/** A default-allowlist match is refused when the name looks like a credential. */
export const SECRETISH = /(TOKEN|KEY|SECRET|PASSW|PASSPHRASE|CREDENTIAL|_AUTH)/i;

const hasUserinfo = (value: string): boolean =>
	/\/\/[^/@\s]*@/.test(value) || /^[^/@\s]*:[^/@\s]*@/.test(value);

const isBase = (name: string, value: string): boolean => {
	const upper = name.toUpperCase();
	if (SECRETISH.test(upper)) return false;
	if (PROXY_NAMES.has(upper)) return !hasUserinfo(value);
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
		if (isBase(k, v) || names.has(upper)) out[k] = v;
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

/** True when the source has variables the child will not see (so a failed command may be missing one). Names and values are never returned. */
export function withheldAny(
	source: Env = process.env,
	extraNames: readonly string[] = [],
): boolean {
	const kept = Object.keys(buildChildEnv(source, extraNames)).length;
	return Object.values(source).filter((v) => v !== undefined).length > kept;
}

export const ENV_PASS_HINT =
	"Note: commands run with a minimal environment. To pass a variable by name, export EIGHT_SHELL_ENV_PASS=NAME in the shell that launches 8gent.";
