/**
 * 8gent Code - compare_layout: render a page headless and diff it against a reference image (#4080).
 *
 * Pilot design-mockup-practice scored 21/23: words and colours matched but d2
 * position was 0.6961 (need 0.77) and CLIP 0.8851 (need 0.89). The 8gent was
 * handed the measured layout of mockup.png (layout-measure.ts) but wrote
 * index.html blind and never looked at how it rendered, so margins, gaps and
 * block sizes drifted by tens of pixels. This closes the loop the same way
 * render_video_deck does: the model supplies the HTML, code does the precise
 * work. It renders the page at the reference's size with the local Chrome,
 * measures the render with the same band measurement used on the reference,
 * pairs the bands, and reports per-band offsets plus a similarity number.
 *
 * Local only: Chrome runs with every host name unresolvable and a dead proxy,
 * and the page is rendered from a sanitised copy under a CSP that blocks every
 * subresource, so it can reach neither the network nor another file. Deterministic: same files in, same numbers out. Any
 * failure returns a plain sentence, never throws.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { type Band, type LayoutMeasure, measureLayout } from "../eight/layout-measure";

const RENDER_TIMEOUT_MS = 30_000;
const MAX_VIEWPORT = 8000;
/** Cost of leaving a band unmatched, in px. A pairing worse than two skips is no pairing. */
const SKIP_COST = 150;
const MAX_REPORT_ROWS = 40;
/** Offsets at or under this are reported as "ok". */
const OK_PX = 2;
const SIM_WIDTH = 320;

/** True when `file` is `dir` or sits inside it. */
function insideDir(file: string, dir: string): boolean {
	let base = path.resolve(dir);
	try {
		base = fs.realpathSync(base);
	} catch {
		// a workspace that does not exist holds nothing
	}
	const rel = path.relative(base, path.resolve(file));
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Find a Chrome or Chromium to render with. Only an absolute path to a real
 * file counts, and never one inside the workspace: the model can write files
 * there, so a binary found there is code it chose to run.
 */
export function findChrome(
	env: Record<string, string | undefined> = process.env,
	workspace: string = process.cwd(),
): string | null {
	const candidates: string[] = [];
	if (env.EIGHT_CHROME_BIN?.trim()) candidates.push(env.EIGHT_CHROME_BIN.trim());
	if (process.platform === "darwin") {
		candidates.push(
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
		);
	} else if (process.platform === "win32") {
		for (const base of [env["PROGRAMFILES"], env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]) {
			if (base) candidates.push(path.join(base, "Google", "Chrome", "Application", "chrome.exe"));
		}
	} else {
		for (const dir of (env.PATH ?? "").split(path.delimiter)) {
			for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
				if (dir) candidates.push(path.join(dir, name));
			}
		}
	}
	return (
		candidates.find((c) => {
			if (!path.isAbsolute(c)) return false;
			try {
				if (!fs.statSync(c).isFile()) return false;
				return !insideDir(fs.realpathSync(c), workspace) && !insideDir(c, workspace);
			} catch {
				return false;
			}
		}) ?? null
	);
}

export const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};
/** Nothing loads except inline styles and data: images. No script, frame, font or fetch. */
export const RENDER_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

/**
 * Write a sanitised copy of the page into `dir` and return its path. The copy
 * carries a CSP that blocks every subresource, loses <base> and meta refresh
 * (they could point the render at another file), and has the images that sit
 * inside the page's own folder inlined as data: URIs, so the page still looks
 * right while no other file or address can be reached.
 */
export function prepareSafeCopy(htmlPath: string, dir: string): string {
	const size = fs.statSync(htmlPath).size;
	if (size > MAX_HTML_BYTES) throw new Error(`the HTML is ${size} bytes, over the ${MAX_HTML_BYTES} byte limit`);
	let html = fs.readFileSync(htmlPath, "utf8");
	const root = fs.realpathSync(path.dirname(htmlPath));
	const inline = (ref: string): string | null => {
		const clean = ref.trim().split(/[?#]/)[0];
		if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith("//")) return null;
		const mime = IMAGE_MIME[path.extname(clean).toLowerCase()];
		if (!mime) return null;
		try {
			const real = fs.realpathSync(path.resolve(root, decodeURIComponent(clean)));
			if (!insideDir(real, root) || fs.statSync(real).size > MAX_INLINE_IMAGE_BYTES) return null;
			return `data:${mime};base64,${fs.readFileSync(real).toString("base64")}`;
		} catch {
			return null;
		}
	};
	html = html
		.replace(/<base\b[^>]*>/gi, "")
		.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, "")
		.replace(/(\bsrc\s*=\s*)(["'])([^"']*)\2/gi, (m, pre, q, ref) => {
			const d = inline(ref);
			return d ? `${pre}${q}${d}${q}` : m;
		})
		.replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi, (m, q, ref) => {
			const d = inline(ref);
			return d ? `url(${q}${d}${q})` : m;
		});
	const meta = `<meta http-equiv="Content-Security-Policy" content="${RENDER_CSP}">`;
	const withMeta = /<head\b[^>]*>/i.test(html)
		? html.replace(/<head\b[^>]*>/i, (h) => `${h}${meta}`)
		: /<html\b[^>]*>/i.test(html)
			? html.replace(/<html\b[^>]*>/i, (h) => `${h}<head>${meta}</head>`)
			: `${meta}${html}`;
	const out = path.join(dir, "page.html");
	fs.writeFileSync(out, withMeta);
	return out;
}

/**
 * Render an HTML file to a PNG at width x height. Offline by construction: every
 * host name fails to resolve and all traffic, loopback and LAN included, goes to
 * a dead proxy. Chrome runs in its own process group, which is killed on timeout
 * and when it exits, so no renderer is left behind.
 */
export function renderHtml(
	chrome: string,
	htmlPath: string,
	out: string,
	width: number,
	height: number,
	profileDir: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const args = [
			"--headless=new",
			"--disable-gpu",
			"--hide-scrollbars",
			"--force-device-scale-factor=1",
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-extensions",
			"--host-resolver-rules=MAP * ~NOTFOUND",
			"--proxy-server=http://127.0.0.1:9",
			"--proxy-bypass-list=<-loopback>",
			"--virtual-time-budget=2000",
			`--user-data-dir=${profileDir}`,
			`--window-size=${width},${height}`,
			`--screenshot=${out}`,
			pathToFileURL(htmlPath).href,
		];
		const useGroup = process.platform !== "win32";
		const child = spawn(chrome, args, { stdio: "ignore", detached: useGroup });
		const killGroup = () => {
			try {
				if (useGroup && child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {
				// already gone
			}
		};
		const timer = setTimeout(() => {
			killGroup();
			reject(new Error(`the render did not finish in ${RENDER_TIMEOUT_MS / 1000}s`));
		}, RENDER_TIMEOUT_MS);
		child.on("error", (e) => {
			clearTimeout(timer);
			killGroup();
			reject(e);
		});
		child.on("exit", () => {
			clearTimeout(timer);
			killGroup();
			fs.existsSync(out) ? resolve() : reject(new Error("the browser produced no screenshot"));
		});
	});
}

/** Sanitise `htmlPath` (see prepareSafeCopy) and render the copy. */
export async function renderSafe(
	chrome: string,
	htmlPath: string,
	out: string,
	width: number,
	height: number,
	dir: string,
): Promise<void> {
	const copy = prepareSafeCopy(htmlPath, dir);
	await renderHtml(chrome, copy, out, width, height, path.join(dir, "profile"));
}

export type BandPair = { ref: Band; got: Band | null };

/** Order-preserving pairing of reference bands to rendered bands, cheapest total offset. */
export function pairBands(ref: Band[], got: Band[]): { pairs: BandPair[]; extra: Band[] } {
	const cost = (a: Band, b: Band) =>
		Math.abs(a.y - b.y) +
		Math.abs(a.x - b.x) +
		Math.abs(a.w - b.w) +
		Math.abs(a.h - b.h) +
		20 * Math.abs(a.spans.length - b.spans.length);
	const n = ref.length;
	const m = got.length;
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
	for (let i = 1; i <= n; i++) dp[i][0] = i * SKIP_COST;
	for (let j = 1; j <= m; j++) dp[0][j] = j * SKIP_COST;
	for (let i = 1; i <= n; i++) {
		for (let j = 1; j <= m; j++) {
			dp[i][j] = Math.min(
				dp[i - 1][j - 1] + cost(ref[i - 1], got[j - 1]),
				dp[i - 1][j] + SKIP_COST,
				dp[i][j - 1] + SKIP_COST,
			);
		}
	}
	const pairs: BandPair[] = [];
	const extra: Band[] = [];
	let i = n;
	let j = m;
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + cost(ref[i - 1], got[j - 1])) {
			pairs.push({ ref: ref[i - 1], got: got[j - 1] });
			i--;
			j--;
		} else if (i > 0 && dp[i][j] === dp[i - 1][j] + SKIP_COST) {
			pairs.push({ ref: ref[i - 1], got: null });
			i--;
		} else {
			extra.push(got[j - 1]);
			j--;
		}
	}
	return { pairs: pairs.reverse(), extra: extra.reverse() };
}

const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

function moveAdvice(label: string, d: number, neg: string, pos: string): string | null {
	if (Math.abs(d) <= OK_PX) return null;
	return `${label} ${signed(d)} (${d < 0 ? neg : pos} ${Math.abs(d)}px)`;
}

/** Grey-level similarity, 0..1, of two images at the reference's size (1 = identical). */
export async function pixelSimilarity(refFile: string, gotFile: string, width: number, height: number): Promise<number | null> {
	try {
		const sharp = (await import("sharp")).default;
		const w = Math.min(SIM_WIDTH, width);
		const h = Math.max(1, Math.round((height * w) / width));
		// Same canvas as the reference, anchored top-left: pad or crop, never rescale,
		// so a page that is too short or too tall is penalised, not stretched to fit.
		const load = async (f: string) => {
			const canvas = await sharp(f)
				.flatten({ background: "#ffffff" })
				.extend({ bottom: height, right: width, background: "#ffffff" })
				.extract({ left: 0, top: 0, width, height })
				.png()
				.toBuffer();
			return sharp(canvas).resize(w, h).greyscale().raw().toBuffer();
		};
		const [a, b] = await Promise.all([load(refFile), load(gotFile)]);
		let sum = 0;
		for (let k = 0; k < a.length; k++) sum += Math.abs(a[k] - b[k]);
		return 1 - sum / (a.length * 255);
	} catch {
		return null;
	}
}

/** The report text for a reference measurement against a render measurement. */
export function describeDiff(ref: LayoutMeasure, got: LayoutMeasure, similarity: number | null): string {
	const { pairs, extra } = pairBands(ref.bands, got.bands);
	const lines: string[] = [];
	lines.push(
		`Compared your render (${got.width}x${got.height} px) with the reference (${ref.width}x${ref.height} px). Offsets are yours minus the reference's: negative x or y means move it right or down.`,
	);
	if (similarity !== null) lines.push(`Pixel similarity ${similarity.toFixed(3)} (1.000 is identical).`);
	lines.push(
		`Content column: reference x=${ref.column.left}..${ref.column.right} (w ${ref.column.width}), yours x=${got.column.left}..${got.column.right} (w ${got.column.width}).`,
	);
	let off = 0;
	const rows: string[] = [];
	for (const { ref: r, got: g } of pairs) {
		if (!g) {
			off++;
			rows.push(`  ref y=${r.y} h=${r.h} x=${r.x} w=${r.w}: MISSING in your page`);
			continue;
		}
		const notes = [
			moveAdvice("y", g.y - r.y, "move down", "move up"),
			moveAdvice("x", g.x - r.x, "move right", "move left"),
			moveAdvice("w", g.w - r.w, "widen", "narrow"),
			moveAdvice("h", g.h - r.h, "make taller", "make shorter"),
		].filter((s): s is string => s !== null);
		if (g.spans.length !== r.spans.length)
			notes.push(`blocks across ${g.spans.length}, reference has ${r.spans.length}`);
		if (notes.length === 0) continue;
		off++;
		rows.push(`  ref y=${r.y} h=${r.h} x=${r.x} w=${r.w}: ${notes.join("; ")}`);
	}
	for (const e of extra) {
		off++;
		rows.push(`  EXTRA band in your page at y=${e.y} h=${e.h} x=${e.x} w=${e.w}: the reference has nothing there`);
	}
	if (off === 0) lines.push("Every content band is within 2px of the reference.");
	else {
		lines.push(`${off} of ${pairs.length + extra.length} bands are off:`);
		lines.push(...rows.slice(0, MAX_REPORT_ROWS));
		if (rows.length > MAX_REPORT_ROWS) lines.push(`  ...and ${rows.length - MAX_REPORT_ROWS} more`);
		lines.push(
			"Fix the largest offsets first (usually the earliest band moves everything below it), then run compare_layout again.",
		);
	}
	return lines.join("\n");
}

/** Render `html` and compare it with `reference`. Always resolves to a sentence. */
export async function compareLayout(htmlPath: string, referencePath: string, workspace: string = process.cwd()): Promise<string> {
	if (!fs.existsSync(htmlPath)) return `compare_layout: ${htmlPath} does not exist. Write the page first.`;
	if (!fs.existsSync(referencePath)) return `compare_layout: reference image ${referencePath} does not exist.`;
	const chrome = findChrome(process.env, workspace);
	if (!chrome) return "compare_layout: no Chrome or Chromium found, so the page cannot be rendered here. Set EIGHT_CHROME_BIN to one.";
	const ref = await measureLayout(referencePath);
	if (!ref) return "compare_layout: could not measure the reference image.";
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-compare-"));
	try {
		const out = path.join(tmp, "render.png");
		const width = Math.min(ref.width, MAX_VIEWPORT);
		const height = Math.min(ref.height, MAX_VIEWPORT);
		await renderSafe(chrome, htmlPath, out, width, height, tmp);
		const got = await measureLayout(out);
		if (!got) return "compare_layout: your page rendered blank. Check the HTML.";
		const similarity = await pixelSimilarity(referencePath, out, ref.width, ref.height);
		return describeDiff(ref, got, similarity);
	} catch (err) {
		return `compare_layout: could not render the page (${err instanceof Error ? err.message : String(err)}).`;
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}
