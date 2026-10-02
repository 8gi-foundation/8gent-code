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

export function chromeArgs(url: string, png: string, profile: string, size: RenderSize): string[] {
	return [
		"--headless=new",
		"--disable-gpu",
		"--hide-scrollbars",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		"--disable-background-networking",
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

/**
 * One screenshot. Resolves once the PNG exists. Chrome prints "bytes written to
 * file" and may then linger, so we end the process group we started ourselves.
 * Only our own child is signalled, never a name match.
 */
function screenshot(
	chrome: string,
	url: string,
	png: string,
	profile: string,
	size: RenderSize,
): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(chrome, chromeArgs(url, png, profile, size), {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let log = "";
		let settled = false;
		const stop = () => {
			if (child.pid === undefined || child.exitCode !== null) return;
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {
				// Already gone.
			}
			const hard = setTimeout(() => {
				try {
					if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}, 3000);
			hard.unref();
		};
		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			stop();
			if (err) reject(err);
			else resolvePromise();
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
			if (existsSync(png)) finish();
			else {
				const tail = log.trim().split("\n").slice(-2).join(" ");
				finish(
					new Error(
						`headless Chrome exited (${code}) without a screenshot${tail ? `: ${tail}` : ""}`,
					),
				);
			}
		});
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
	) {}

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
		);
		const bytes = readFileSync(png);
		rmSync(png, { force: true });
		return bytes;
	}

	async close(): Promise<void> {
		this.closed = true;
		rmSync(this.workDir, { recursive: true, force: true });
	}
}

export class ChromeHeadlessBackend implements RenderBackend {
	readonly name = "chrome-headless" as const;
	private readonly env: Env;
	private probed: Promise<Availability> | null = null;

	constructor(options: { env?: Env } = {}) {
		this.env = options.env ?? process.env;
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
		return new ChromeSession(chrome, abs, size, mkdtempSync(join(tmpdir(), "8gent-render-")));
	}
}
