/**
 * Desktop permission preflight.
 *
 * macOS attaches Screen Recording and Accessibility to the HOST APP (the
 * terminal or 8gent.app the process runs inside), not to the script. When a
 * grant is missing, the only honest answer is one line naming what to grant
 * and to which app. Nothing here works around a missing grant.
 */
import { spawnSync } from "node:child_process";
import { type PermissionsReport, checkPermissions } from "../hands";

export interface PreflightResult {
	ok: boolean;
	/** The grant line when `ok` is false, e.g. "Grant Screen Recording to Ghostty in ...". */
	line?: string;
	missing: Array<"Screen Recording" | "Accessibility">;
	app: string;
}

/** TERM_PROGRAM values as the apps name themselves in System Settings. */
const HOST_NAMES: Record<string, string> = {
	Apple_Terminal: "Terminal",
	"iTerm.app": "iTerm",
	iTerm: "iTerm",
	ghostty: "Ghostty",
	Ghostty: "Ghostty",
	WarpTerminal: "Warp",
	vscode: "Visual Studio Code",
	"Visual Studio Code": "Visual Studio Code",
	Hyper: "Hyper",
	kitty: "kitty",
	Alacritty: "Alacritty",
	WezTerm: "WezTerm",
	"8gent": "8gent.app",
	"8gent.app": "8gent.app",
};

/**
 * __CFBundleIdentifier is set by Launch Services for every process started
 * from an app, and survives tmux and multiplexers (herdr) that rewrite
 * TERM_PROGRAM. It names the app macOS keys the privacy grant on.
 */
const BUNDLE_IDS: Record<string, string> = {
	"com.apple.Terminal": "Terminal",
	"com.googlecode.iterm2": "iTerm",
	"com.mitchellh.ghostty": "Ghostty",
	"dev.warp.Warp-Stable": "Warp",
	"com.microsoft.VSCode": "Visual Studio Code",
	"net.kovidgoyal.kitty": "kitty",
	"org.alacritty": "Alacritty",
	"com.github.wez.wezterm": "WezTerm",
};

/** Walk up the process tree for the first `.app` bundle; null when ps is unavailable. */
export function hostAppFromProcessTree(startPid = process.ppid, maxDepth = 8): string | null {
	let pid = startPid;
	for (let i = 0; i < maxDepth && pid > 1; i++) {
		let out = "";
		try {
			const r = spawnSync("/bin/ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
				encoding: "utf-8",
				timeout: 1500,
			});
			if (r.status !== 0) return null;
			out = (r.stdout || "").trim();
		} catch {
			return null;
		}
		const m = /^(\d+)\s+(.*)$/.exec(out);
		if (!m) return null;
		const bundle = /\/([^/]+)\.app\//.exec(m[2]);
		if (bundle) return bundle[1];
		pid = Number(m[1]);
	}
	return null;
}

/**
 * The app a person must find in System Settings. A bundle on the process
 * tree wins (it is what macOS keys the grant on); then the Launch Services
 * bundle id; else TERM_PROGRAM.
 */
export function resolveHostApp(
	env: Record<string, string | undefined> = process.env,
	fromTree: () => string | null = hostAppFromProcessTree,
): string {
	const raw = env.TERM_PROGRAM || "";
	// tmux and harnesses are not the app macOS grants to; look past them.
	const bundle = fromTree();
	if (bundle) return HOST_NAMES[bundle] ?? bundle;
	const id = env.__CFBundleIdentifier;
	if (id && BUNDLE_IDS[id]) return BUNDLE_IDS[id];
	if (raw && HOST_NAMES[raw]) return HOST_NAMES[raw];
	return raw ? `the app running 8gent (TERM_PROGRAM=${raw})` : "the app running 8gent";
}

/** Build the one-line result from a permissions probe. Pure. */
export function preflightFromReport(report: PermissionsReport, app: string): PreflightResult {
	const missing: PreflightResult["missing"] = [];
	if (!report.screenRecording.granted) missing.push("Screen Recording");
	if (!report.accessibility.granted) missing.push("Accessibility");
	if (missing.length === 0) return { ok: true, missing, app };
	return {
		ok: false,
		missing,
		app,
		line: `Grant ${missing.join(" and ")} to ${app} in System Settings > Privacy & Security, then restart 8gent.`,
	};
}

let grantedOnce = false;

/**
 * Probe once per act. A pass is cached for the process (grants only change
 * with a restart); a failure is re-probed every time so a fresh grant is seen.
 */
export function desktopPreflight(
	probe: () => PermissionsReport = checkPermissions,
): PreflightResult {
	const app = resolveHostApp();
	if (grantedOnce) return { ok: true, missing: [], app };
	const result = preflightFromReport(probe(), app);
	if (result.ok) grantedOnce = true;
	return result;
}

/** Test-only. */
export function _resetPreflightCache(): void {
	grantedOnce = false;
}
