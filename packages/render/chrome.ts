/**
 * @8gent/render - headless Chrome backend (#3346).
 *
 * The secondary backend. It works outside the agent sandbox only: a third-party
 * Chrome launched from inside the sandbox fails to start, which is why
 * `available()` does a real launch instead of only checking the binary exists.
 *
 * Lifted from the two private copies that exist today, keeping the stronger
 * parts of each:
 *   - packages/deck/render.ts: EIGHT_CHROME_PATH, Linux paths, an isolated
 *     profile, and ending the process group once the PNG is written (recent
 *     macOS Chrome builds stay alive after the screenshot).
 *   - packages/table/bake.ts and deck2video.py: --virtual-time-budget so the
 *     page settles before the shot.
 * Those two callers are not switched here; that is #3346 PR 6.
 *
 * Chrome has no seek, so a session is one launch per capture, with the slide
 * passed as `#slide=k` (the deck2video capture-shim convention).
 *
 * Trust boundary. This backend renders only HTML our own pipeline generated,
 * never HTML taken straight from a model or a third party. The page loads from
 * file://, and while its scripts cannot read other files, Chrome still lets a
 * file:// page embed other local files for display (an <iframe> or <img> of any
 * path), and that content lands in the PNG, which becomes a posted video frame.
 * No flag closes that. TODO(#3352): serve the deck from a loopback HTTP origin
 * that serves only the deck directory, so file:// is never the page origin.
 *
 * Network. The page gets no network unless the caller passes allowNetwork: every
 * host but localhost resolves to nothing, and a dead proxy catches literal IPs.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Availability, RenderBackend, RenderSession, RenderSize } from "./backend";

type Env = Record<string, string | undefined>;

const CHROME_CANDIDATES = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
];

/** Settle time before the shot, in virtual ms. Same value bake.ts uses. */
export const SETTLE_MS = 2000;
const SHOT_TIMEOUT_MS = 60_000;
/** SIGTERM to SIGKILL. */
const HARD_KILL_MS = 3000;
/** How long to wait for the leader to exit after the SIGKILL before giving up. */
const EXIT_WAIT_MS = HARD_KILL_MS + 2000;

/** Blocks the page's own network. Chrome's background traffic is off separately. */
export const NETWORK_BLOCK_ARGS: readonly string[] = [
	"--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost",
	// Belt and braces for literal IPs, which skip the resolver: port 9 is discard.
	"--proxy-server=127.0.0.1:9",
];

export interface ChromeOptions {
	/** Let the deck reach the network. Off by default; a caller that needs it says so. */
	allowNetwork?: boolean;
}

export function findChrome(env: Env = process.env): string | null {
	const override = env.EIGHT_CHROME_PATH?.trim();
	if (override) return existsSync(override) ? override : null;
	return CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

/** The URL Chrome loads: the file, plus `#slide=k` once a slide has been shown. */
export function slideUrl(htmlPath: string, slide: number | null): string {
	const href = pathToFileURL(htmlPath).href;
	return slide === null ? href : `${href}#slide=${slide}`;
}

export function chromeArgs(
	url: string,
	png: string,
	profile: string,
	size: RenderSize,
	options: ChromeOptions = {},
): string[] {
	return [
		"--headless=new",
		"--disable-gpu",
		"--hide-scrollbars",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		"--disable-background-networking",
		...(options.allowNetwork === true ? [] : NETWORK_BLOCK_ARGS),
		"--disable-component-update",
		"--disable-sync",
		"--disable-breakpad",
		"--no-service-autorun",
		"--mute-audio",
		"--force-device-scale-factor=1",
		`--virtual-time-budget=${SETTLE_MS}`,
		`--user-data-dir=${profile}`,
		`--window-size=${size.width},${size.height}`,
		`--screenshot=${png}`,
		url,
	];
}

/** Signal every process in the group. False once the group is empty. */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
	try {
		process.kill(-pid, signal);
		return true;
	} catch {
		return false;
	}
}

/**
 * One screenshot. Chrome prints "bytes written to file" and may then linger, so
 * once the PNG exists we end the process group we started ourselves, even if the
 * leader already exited (its helpers can outlive it). Only our own group is
 * signalled, never a name match. Resolves only after the leader has exited (or
 * EXIT_WAIT_MS has passed), so callers can delete the profile without a live
 * Chrome writing into it again.
 */
function screenshot(
	chrome: string,
	url: string,
	png: string,
	profile: string,
	size: RenderSize,
	options: ChromeOptions,
): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(chrome, chromeArgs(url, png, profile, size, options), {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let log = "";
		let outcome: { err?: Error } | null = null;
		let exited = false;
		let settled = false;
		let hard: ReturnType<typeof setTimeout> | undefined;
		let exitWait: ReturnType<typeof setTimeout> | undefined;

		const settle = () => {
			if (settled || !outcome) return;
			settled = true;
			clearTimeout(exitWait);
			if (outcome.err) reject(outcome.err);
			else resolvePromise();
		};
		const stop = () => {
			const pid = child.pid;
			if (pid === undefined) return;
			signalGroup(pid, "SIGTERM");
			// Not unref'd: a short-lived CLI must not exit before the SIGKILL lands.
			hard = setTimeout(() => signalGroup(pid, "SIGKILL"), HARD_KILL_MS);
		};
		const finish = (err?: Error) => {
			if (outcome) return;
			outcome = { err };
			clearTimeout(timer);
			stop();
			if (exited || child.pid === undefined) settle();
			else exitWait = setTimeout(settle, EXIT_WAIT_MS);
		};
		const timer = setTimeout(
			() => finish(new Error("headless Chrome timed out taking a screenshot")),
			SHOT_TIMEOUT_MS,
		);
		const onData = (chunk: Buffer) => {
			log = (log + chunk.toString()).slice(-4000);
			if (/bytes written to file/.test(log) && existsSync(png)) finish();
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.on("error", (err) => finish(new Error(`could not start Chrome: ${err.message}`)));
		child.on("exit", (code) => {
			exited = true;
			if (existsSync(png)) finish();
			else {
				const tail = log.trim().split("\n").slice(-2).join(" ");
				finish(
					new Error(
						`headless Chrome exited (${code}) without a screenshot${tail ? `: ${tail}` : ""}`,
					),
				);
			}
			// The group is empty once the leader and every helper are gone: skip the SIGKILL.
			if (child.pid !== undefined && !signalGroup(child.pid, 0)) clearTimeout(hard);
			settle();
		});
	});
}

/**
 * Session dirs not yet closed. Removed at process exit, so a caller that throws
 * before close() does not leak one. Callers should still close() in a finally.
 */
const openDirs = new Set<string>();
let exitHookInstalled = false;
function trackDir(dir: string): void {
	openDirs.add(dir);
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.on("exit", () => {
		for (const d of openDirs) rmSync(d, { recursive: true, force: true });
	});
}

export class ChromeSession implements RenderSession {
	private slide: number | null = null;
	private shots = 0;
	private closed = false;

	constructor(
		private readonly chrome: string,
		private readonly htmlPath: string,
		private readonly size: RenderSize,
		/** Owned by this session; close() removes it. */
		readonly workDir: string,
		private readonly options: ChromeOptions = {},
	) {
		trackDir(workDir);
	}

	async show(slide: number): Promise<void> {
		if (this.closed) throw new Error("render session is closed");
		this.slide = slide;
	}

	async capture(): Promise<Uint8Array> {
		if (this.closed) throw new Error("render session is closed");
		const png = join(this.workDir, `shot-${this.shots++}.png`);
		await screenshot(
			this.chrome,
			slideUrl(this.htmlPath, this.slide),
			png,
			join(this.workDir, "profile"),
			this.size,
			this.options,
		);
		const bytes = readFileSync(png);
		rmSync(png, { force: true });
		return bytes;
	}

	async close(): Promise<void> {
		this.closed = true;
		rmSync(this.workDir, { recursive: true, force: true });
		openDirs.delete(this.workDir);
	}
}

export class ChromeHeadlessBackend implements RenderBackend {
	readonly name = "chrome-headless" as const;
	private readonly env: Env;
	private readonly options: ChromeOptions;
	private probed: Promise<Availability> | null = null;

	constructor(options: { env?: Env } & ChromeOptions = {}) {
		this.env = options.env ?? process.env;
		this.options = { allowNetwork: options.allowNetwork === true };
	}

	/** A real 1x1 launch, memoised per instance. Finding the binary is not enough. */
	available(): Promise<Availability> {
		this.probed ??= this.probe();
		return this.probed;
	}

	private async probe(): Promise<Availability> {
		const chrome = findChrome(this.env);
		if (!chrome) {
			const override = this.env.EIGHT_CHROME_PATH?.trim();
			return {
				ok: false,
				reason: override
					? `EIGHT_CHROME_PATH=${override} does not exist`
					: "no Chrome, Chromium, Edge or Brave found; set EIGHT_CHROME_PATH",
			};
		}
		const work = mkdtempSync(join(tmpdir(), "8gent-render-probe-"));
		try {
			const page = join(work, "probe.html");
			writeFileSync(page, "<!doctype html><html><body></body></html>");
			await screenshot(
				chrome,
				slideUrl(page, null),
				join(work, "probe.png"),
				join(work, "profile"),
				{
					width: 1,
					height: 1,
				},
				this.options,
			);
			return { ok: true };
		} catch (err) {
			return {
				ok: false,
				reason: `${chrome}: ${err instanceof Error ? err.message : String(err)}`,
			};
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	}

	async open(htmlPath: string, size: RenderSize): Promise<RenderSession> {
		const chrome = findChrome(this.env);
		if (!chrome) throw new Error("no Chrome binary found; set EIGHT_CHROME_PATH");
		const abs = resolve(htmlPath);
		if (!existsSync(abs)) throw new Error(`no such document: ${abs}`);
		return new ChromeSession(
			chrome,
			abs,
			size,
			mkdtempSync(join(tmpdir(), "8gent-render-")),
			this.options,
		);
	}
}
