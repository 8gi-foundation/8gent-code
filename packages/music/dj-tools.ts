/**
 * The DJ's own mpv, yt-dlp and ffmpeg, fetched on first use (#4916 path, DJ zero-install).
 *
 * Same rule as llama-server and whisper-cli (packages/eight/runtime-fetch.ts): the files are
 * assets of 8gent's own GitHub release for the running version, named by dj-tool-pins.json,
 * checked against that release's SHA256SUMS (and its signature once a release key is set),
 * smoke-run in their staging name, then renamed into ~/.8gent/bin/dj. Nothing comes from a
 * package manager. A system tool already on PATH is used when 8gent has none of its own.
 *
 * dj-tool-pins.json lists, per tool, the targets whose build is attached to releases and its
 * size. A tool or target not listed has no pinned build: /dj offers nothing to download for it
 * and keeps today's install command. The CI job that builds and attaches the files adds the
 * entries as each target lands.
 *
 * Every network and disk effect is injected so tests download nothing.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveHome } from "../core/home";
import { type BinaryResult, type FetchDeps, fetchVerifiedAsset } from "../eight/runtime-fetch";
import { isAndroidHost } from "../voice/termux";
import pins from "./dj-tool-pins.json";

type Env = Record<string, string | undefined>;

export type DjTool = "mpv" | "yt-dlp" | "ffmpeg";

/** One entry of the pins: the size shown in the question, in MB. */
export interface PinnedBuild {
	mb: number;
}
export interface DjToolPins {
	asset: string;
	targets: Record<string, Record<string, PinnedBuild>>;
}

/** `--version` for each tool: the smoke check run on the staged file before it is renamed into place. */
const SMOKE_ARGS: Record<DjTool, string[]> = {
	mpv: ["--version"],
	"yt-dlp": ["--version"],
	ffmpeg: ["-version"],
};

/** The release target of this machine for the DJ's tools, or null. Windows is a target here (the runtime's is not). */
export function djTarget(
	platform: string = process.platform,
	arch: string = process.arch,
	env: Env = process.env,
): string | null {
	const a = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
	if (!a) return null;
	if (isAndroidHost(platform, env)) return a === "arm64" ? "android-arm64" : null;
	if (platform === "linux" || platform === "darwin") return `${platform}-${a}`;
	if (platform === "win32") return a === "x64" ? "win32-x64" : null;
	return null;
}

/** The release asset name of a tool on a target, from the pins' naming rule. */
export function djAssetName(
	tool: DjTool,
	target: string,
	rule: string = (pins as DjToolPins).asset,
): string {
	return rule
		.replace("{tool}", tool)
		.replace("{target}", target)
		.replace("{ext}", target.startsWith("win32") ? ".exe" : "");
}

/** Where 8gent keeps its own copy of a tool. */
export function managedDjTool(
	tool: DjTool,
	env: Env = process.env,
	platform: string = process.platform,
): string {
	return join(resolveHome(env), ".8gent", "bin", "dj", platform === "win32" ? `${tool}.exe` : tool);
}

/** 8gent's own copy of a tool, if it has been fetched. */
export function findManagedDjTool(
	tool: DjTool,
	env: Env = process.env,
	platform: string = process.platform,
	exists: (p: string) => boolean = existsSync,
): string | null {
	const p = managedDjTool(tool, env, platform);
	return exists(p) ? p : null;
}

/** What /dj would download for the tools it is missing: the ones with a pinned build here, and their total size. */
export interface DownloadPlan {
	target: string;
	tools: DjTool[];
	mb: number;
}

/** The pinned downloads for these missing tools on this machine, or null when none has a pinned build. */
export function downloadPlan(
	missing: readonly string[],
	opts: { platform?: string; arch?: string; env?: Env; pins?: DjToolPins } = {},
): DownloadPlan | null {
	const p = opts.pins ?? (pins as DjToolPins);
	const target = djTarget(opts.platform, opts.arch, opts.env);
	if (!target) return null;
	const tools = (missing as DjTool[]).filter((t) => p.targets[t]?.[target]);
	if (tools.length === 0) return null;
	return { target, tools, mb: tools.reduce((n, t) => n + p.targets[t][target].mb, 0) };
}

export interface DjFetchDeps extends FetchDeps {
	pins?: DjToolPins;
}

const defaultRuns = (tool: DjTool) => (bin: string) =>
	spawnSync(bin, SMOKE_ARGS[tool], { stdio: "ignore", timeout: 15_000 }).status === 0;

/** Download, verify and install one DJ tool for this machine and version into ~/.8gent/bin/dj. */
export function fetchDjTool(tool: DjTool, deps: DjFetchDeps = {}): Promise<BinaryResult> {
	const env = deps.env ?? process.env;
	const platform = deps.platform ?? process.platform;
	const target = djTarget(platform, deps.arch, env);
	const p = deps.pins ?? (pins as DjToolPins);
	if (!target || !p.targets[tool]?.[target])
		return Promise.resolve({ ok: false, why: `8gent has no ${tool} build for this platform yet` });
	return fetchVerifiedAsset(
		djAssetName(tool, target, p.asset),
		managedDjTool(tool, env, platform),
		deps,
		defaultRuns(tool),
	);
}
