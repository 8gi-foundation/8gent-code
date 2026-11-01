/**
 * @8gent/terminal-tab - pty-available.ts
 *
 * Can a terminal tab open here? node-pty is an optionalDependency (#3256) and
 * `8gent update` installs with --ignore-scripts, so on Termux (and any box
 * without build tools) it is never compiled. Ask before opening a tab, so the
 * person gets one line instead of a tab that opens, prints a paragraph and exits.
 *
 * The probe is `require("node-pty")` run by Node from the bridge's own folder,
 * which is exactly how pty-bridge.cjs loads it, so the answer cannot disagree
 * with what the tab would do. Cached: the answer does not change mid-session.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAndroidHost } from "../voice/termux.js";
import { findNodeBinary } from "./find-node.js";

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), "pty-bridge.cjs");
const PROBE = 'require("node:module").createRequire(process.argv[1])("node-pty")';

export type PtyCheck = { ok: true } | { ok: false; reason: string };

let cached: PtyCheck | null = null;

export function checkNodePty(
	cwd: string = process.cwd(),
	force = false,
	bridge: string = BRIDGE,
): PtyCheck {
	if (cached && !force) return cached;
	const nodeBin = findNodeBinary(cwd);
	if (!nodeBin) return (cached = { ok: false, reason: "no Node runtime found" });
	const r = spawnSync(nodeBin, ["-e", PROBE, bridge], {
		encoding: "utf-8",
		timeout: 10_000,
		stdio: ["ignore", "ignore", "pipe"],
	});
	if (r.status === 0) return (cached = { ok: true });
	const first =
		String(r.stderr ?? "")
			.split("\n")
			.find((l) => /Error/.test(l)) ?? "";
	return (cached = { ok: false, reason: first.trim().slice(0, 120) || "node-pty did not load" });
}

/** For tests only. */
export function resetPtyCheck(): void {
	cached = null;
}

/** The one line that tells the person how to get terminal tabs on this machine. */
export function ptyFixLine(
	platform: string = process.platform,
	env: Record<string, string | undefined> = process.env,
): string {
	if (isAndroidHost(platform, env))
		return `Terminal tabs need node-pty. In Termux: pkg install python make clang && cd "$(npm root -g)/@8gi-foundation/8gent-code" && GYP_DEFINES="android_ndk_path=''" npm rebuild node-pty`;
	if (platform === "darwin")
		return 'Terminal tabs need node-pty. Run: xcode-select --install && cd "$(npm root -g)/@8gi-foundation/8gent-code" && npm rebuild node-pty';
	return 'Terminal tabs need node-pty. Install python3, make and g++, then: cd "$(npm root -g)/@8gi-foundation/8gent-code" && npm rebuild node-pty';
}
