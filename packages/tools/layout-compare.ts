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
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { type Band, type LayoutMeasure, measureLayout } from "../eight/layout-measure";
import { cachedHeadlessShells } from "../render/chrome";

const RENDER_TIMEOUT_MS = 30_000;
const MAX_VIEWPORT = 8000;
/** Cost of leaving a band unmatched, in px. A pairing worse than two skips is no pairing. */
const SKIP_COST = 150;
const MAX_REPORT_ROWS = 40;
/** Offsets at or under this are reported as "ok". */
const OK_PX = 2;
const SIM_WIDTH = 320;
/** Cap on the DOM Chrome prints in the element pass: the page cap plus room for the boxes. */
const MAX_DOM_BYTES = 8 * 1024 * 1024;
/** An element names a band only when their boxes overlap at least this much (intersection over union). */
const MIN_NAME_IOU = 0.3;
/** Selector text is page-controlled: at most this many characters reach the model. */
const MAX_SELECTOR_CHARS = 120;
/** At most this many element boxes are read back from the element pass. */
const MAX_ELEMENTS = 3000;

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
	// Never a user's own browser under /Applications (or a Windows Program Files install):
	// launched from a background or sandboxed process it aborts and macOS shows the user a crash
	// report. Only EIGHT_CHROME_BIN (explicit), a bundled headless shell, or a Linux package
	// binary on PATH qualifies.
	candidates.push(...cachedHeadlessShells(env.HOME?.trim() || os.homedir()));
	if (process.platform === "linux") {
		for (const dir of (env.PATH ?? "").split(path.delimiter)) {
			for (const name of [
				"google-chrome",
				"google-chrome-stable",
				"chromium",
				"chromium-browser",
			]) {
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
 * carries a CSP that blocks every subresource and all script, loses <base> and has
 * every http-equiv disarmed (a refresh could point the render at another file), and
 * has the images that sit inside the page's own folder inlined as data: URIs, so the page still looks
 * right while no other file or address can be reached.
 */
export function prepareSafeCopy(htmlPath: string, dir: string, probe?: string): string {
	const size = fs.statSync(htmlPath).size;
	if (size > MAX_HTML_BYTES)
		throw new Error(`the HTML is ${size} bytes, over the ${MAX_HTML_BYTES} byte limit`);
	// No leading BOM (one is written below) and no ESC: ISO-2022-JP's escape sequences
	// print nothing, so "http<ESC>(B-equiv" would decode to a live http-equiv.
	let html = fs
		.readFileSync(htmlPath, "utf8")
		.replace(/^\uFEFF+/, "")
		.replaceAll("\x1b", "");
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
		// The match above reads the value, which entities (&#114;efresh) or a quoted ">" slip
		// past. An attribute NAME cannot be entity-encoded, so every http-equiv is disarmed:
		// no page-supplied refresh can navigate to an unsanitised file that would run script.
		.replace(/\bhttp-equiv\b/gi, "data-blocked-http-equiv")
		.replace(/(\bsrc\s*=\s*)(["'])([^"']*)\2/gi, (m, pre, q, ref) => {
			const d = inline(ref);
			return d ? `${pre}${q}${d}${q}` : m;
		})
		.replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi, (m, q, ref) => {
			const d = inline(ref);
			return d ? `url(${q}${d}${q})` : m;
		});
	// The element pass (#4204) runs one script of ours, allowed by its hash alone: the page's
	// own script, handlers and javascript: URLs stay blocked exactly as in the screenshot pass.
	const csp = probe
		? `${RENDER_CSP}; script-src 'sha256-${createHash("sha256").update(probe).digest("base64")}'`
		: RENDER_CSP;
	const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
	// First thing in the document, never after a text match: a script before <head>,
	// or a fake <head> inside a comment, must not run ahead of the policy. A meta
	// before <html> is parsed into the implicit head. A doctype stays first. Exactly one
	// UTF-8 BOM leads, so Chrome decodes as UTF-8 and ignores any page <meta charset>
	// (a second U+FEFF would be text, opening the body before the CSP meta).
	// Only the whitespace the HTML parser skips: JS \s also takes NBSP, U+3000, U+2028 and
	// U+FEFF, which the parser treats as text, opening the body before the CSP meta.
	const lead = /^[\t\n\f\r ]*<!doctype[^>]*>/i.exec(html)?.[0] ?? "";
	// The probe sits straight after the policy, before any page byte: page markup that ends
	// in an open tag, comment or raw-text element cannot swallow it or lend it attributes.
	const withMeta = `\uFEFF${lead}${meta}${probe ? `<script>${probe}</script>` : ""}${html.slice(lead.length)}`;
	const out = path.join(dir, probe ? "page-elements.html" : "page.html");
	fs.writeFileSync(out, withMeta);
	return out;
}

/** Chrome's argv for one offline render; `out` null dumps the DOM to stdout instead. Exported so a test can assert the lock-down flags. */
export function chromeArgs(
	htmlPath: string,
	out: string | null,
	width: number,
	height: number,
	profileDir: string,
	env: Record<string, string | undefined> = process.env,
): string[] {
	return [
		"--headless=new",
		"--disable-gpu",
		"--hide-scrollbars",
		"--force-device-scale-factor=1",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		// Crashpad would write its settings under the real home; a render needs no crash reporter.
		"--disable-breakpad",
		"--disable-default-apps",
		"--disable-sync",
		"--disable-background-networking",
		"--disable-component-update",
		"--disable-domain-reliability",
		"--dns-prefetch-disable",
		"--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
		// No --blink-settings=scriptEnabled=false: Chrome runs --screenshot through its own
		// chrome://headless command page, which needs script, so that flag left no screenshot
		// (exit 0, #4124). The page's script is blocked by RENDER_CSP, first in the document.
		"--host-resolver-rules=MAP * ~NOTFOUND",
		"--proxy-server=http://127.0.0.1:9",
		"--proxy-bypass-list=<-loopback>",
		"--virtual-time-budget=2000",
		// Only for a CI runner whose kernel forbids Chrome's own sandbox; never set by default.
		...(env.EIGHT_CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
		`--user-data-dir=${profileDir}`,
		`--window-size=${width},${height}`,
		out === null ? "--dump-dom" : `--screenshot=${out}`,
		pathToFileURL(htmlPath).href,
	];
}

const CHROME_LOCK_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

/** Longest unix socket path macOS accepts is 103 bytes; stay under it with margin. */
export const MAX_SOCKET_PATH_BYTES = 100;

/** Worst-case path of Chrome's ProcessSingleton socket under a TMPDIR. */
export function chromeSocketPath(tmpdir: string): string {
	return `${tmpdir}/com.google.Chrome.XXXXXX/SingletonSocket`;
}

/**
 * Get a profile dir ready for Chrome: drop any stale Singleton lock files (a lock left by an
 * earlier launch makes Chrome refuse to start) and, when it fits, give Chrome a short private
 * TMPDIR (mkdtemp under /tmp, else os.tmpdir()). Chrome binds its ProcessSingleton socket under
 * TMPDIR/com.google.Chrome.XXXXXX, and a host that forbids that bind in the shared temp dir
 * broke the render (#4234). A base whose worst-case socket path passes the unix sun_path limit
 * is skipped, and if none fits the inherited TMPDIR is kept rather than break the launch.
 * Returns the env to launch Chrome with and a cleanup that removes the private dir.
 */
export function prepareChromeProfile(
	profileDir: string,
	env: Record<string, string | undefined> = process.env,
	bases: string[] = ["/tmp", os.tmpdir()],
): { env: Record<string, string | undefined>; cleanup: () => void } {
	for (const f of CHROME_LOCK_FILES) fs.rmSync(path.join(profileDir, f), { force: true });
	for (const base of bases) {
		const prefix = path.join(base, "8gc-");
		if (Buffer.byteLength(chromeSocketPath(`${prefix}XXXXXX`)) > MAX_SOCKET_PATH_BYTES) continue;
		try {
			const tmp = fs.mkdtempSync(prefix);
			return {
				env: { ...env, TMPDIR: tmp },
				cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
			};
		} catch {
			// not writable: try the next base
		}
	}
	return { env, cleanup: () => {} };
}

type ChromeExit = {
	code: number | null;
	signal: NodeJS.Signals | null;
	stderr: string;
	stdout: string;
};

/**
 * Run Chrome once and wait for it to exit. Offline by construction (see chromeArgs): every
 * host name fails to resolve and all traffic, loopback and LAN included, goes to a dead
 * proxy. Chrome runs in its own process group, which is killed on timeout and when it
 * exits, so no renderer is left behind. stdout is kept only when asked, up to a cap.
 */
function runChrome(
	chrome: string,
	args: string[],
	keepStdout: boolean,
	profileDir: string,
): Promise<ChromeExit> {
	return new Promise((resolve, reject) => {
		const { env, cleanup } = prepareChromeProfile(profileDir);
		const useGroup = process.platform !== "win32";
		const child = spawn(chrome, args, {
			stdio: ["ignore", keepStdout ? "pipe" : "ignore", "pipe"],
			detached: useGroup,
			env: env as NodeJS.ProcessEnv,
		});
		let stderr = "";
		let stdout = "";
		// stderr is kept (last few KB) so a failed render says why Chrome stopped.
		child.stderr?.on("data", (d) => {
			stderr = (stderr + String(d)).slice(-STDERR_KEEP_BYTES);
		});
		child.stdout?.on("data", (d) => {
			if (stdout.length < MAX_DOM_BYTES) stdout += String(d);
		});
		child.on("close", cleanup);
		child.on("error", cleanup);
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
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			killGroup();
			// Give the pipes a moment to drain what Chrome wrote just before it exited.
			setTimeout(() => resolve({ code, signal, stderr, stdout }), 50);
		});
	});
}

/** Render an HTML file to a PNG at width x height, offline (see runChrome). */
export async function renderHtml(
	chrome: string,
	htmlPath: string,
	out: string,
	width: number,
	height: number,
	profileDir: string,
): Promise<void> {
	const exit = await runChrome(
		chrome,
		chromeArgs(htmlPath, out, width, height, profileDir),
		false,
		profileDir,
	);
	if (!fs.existsSync(out))
		throw new Error(noScreenshotMessage(exit.code, exit.signal, exit.stderr));
}

const STDERR_KEEP_BYTES = 4096;
const STDERR_SHOW_LINES = 12;

/** "the browser produced no screenshot", plus Chrome's exit status and its last stderr lines. */
export function noScreenshotMessage(
	code: number | null,
	signal: NodeJS.Signals | null,
	stderr: string,
): string {
	const status = signal ? `signal ${signal}` : `exit code ${code}`;
	const tail = stderr.trim().split(/\r?\n/).slice(-STDERR_SHOW_LINES).join("\n");
	const lock = /ProcessSingleton|Singleton(Lock|Socket|Cookie)/.test(stderr)
		? "\nNote: compare_layout gives Chrome a fresh private profile and clears its lock files itself. Do not delete Singleton files or kill Chrome; this host cannot start Chrome for a render, so check the HTML by hand."
		: "";
	return `the browser produced no screenshot (${status})${tail ? `; Chrome said:\n${tail}` : "; Chrome wrote nothing to stderr"}${lock}`;
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
export async function pixelSimilarity(
	refFile: string,
	gotFile: string,
	width: number,
	height: number,
): Promise<number | null> {
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

/** One visible element of the rendered page: a CSS selector and its box in page pixels. */
export type ElementBox = { s: string; x: number; y: number; w: number; h: number };

/** The id of the probe's output tag. `token` is fresh per run, so the page cannot pre-place one. */
export const boxesId = (token: string): string => `__8gent_layout_boxes_${token}__`;
/**
 * The element pass's script (#4204). After load it records every visible element's selector
 * (tag#id; else tag.classes when that is unique; else an nth-of-type path up to an id or body)
 * and box into a JSON script tag, which --dump-dom prints. The CSP allows it by hash. `token`
 * (hex, fresh per run) names the output tag so page markup cannot forge it; selectors are cut
 * to MAX_SELECTOR_CHARS in the page so a huge class name cannot balloon the dump.
 */
export const elementProbe = (
	token: string,
): string => `addEventListener("load",function(){var E=CSS.escape,S={SCRIPT:1,STYLE:1,BR:1,TEMPLATE:1,NOSCRIPT:1},out=[];
function part(e){var t=e.tagName.toLowerCase();if(e.id)return t+"#"+E(e.id);var c="";if(typeof e.className==="string")e.className.trim().split(/\\s+/).forEach(function(k){if(k)c+="."+E(k)});
var p=e.parentElement,i=0,n=0;if(p)for(var x=p.firstElementChild;x;x=x.nextElementSibling)if(x.tagName===e.tagName){n++;if(x===e)i=n}return t+c+(n>1?":nth-of-type("+i+")":"")}
function sel(e){if(e.id)return part(e);var t=e.tagName.toLowerCase(),c=part(e).replace(/:nth-of-type\\(\\d+\\)$/,"");try{if(c!==t&&document.querySelectorAll(c).length===1)return c}catch(_){}
var a=[part(e)],p=e.parentElement;while(p&&p!==document.body&&a.length<5){a.unshift(part(p));if(p.id)break;p=p.parentElement}return a.join(" > ")}
var all=document.body?document.body.getElementsByTagName("*"):[];for(var k=0;k<all.length&&out.length<${MAX_ELEMENTS};k++){var e=all[k];if(S[e.tagName])continue;var r=e.getBoundingClientRect();if(r.width<1||r.height<1)continue;
if(getComputedStyle(e).visibility!=="visible")continue;out.push({s:sel(e).slice(0,${MAX_SELECTOR_CHARS}),x:Math.round(r.left+scrollX),y:Math.round(r.top+scrollY),w:Math.round(r.width),h:Math.round(r.height)})}
var j=document.createElement("script");j.type="application/json";j.id="${boxesId(token)}";j.textContent=JSON.stringify(out).replace(/</g,"\\\\u003c");(document.body||document.documentElement).appendChild(j)});`;

/**
 * A page-controlled selector made safe to show the model. Allowlist, not denylist: only
 * printable ASCII and Unicode letters and digits survive; every other code point (controls,
 * line breaks, bidi, zero-width, tag characters U+E0000.., variation selectors, combining
 * marks, private use, lone surrogates) becomes a space, so a class name can neither open a
 * new line nor smuggle invisible text. Whitespace collapsed, cut to MAX_SELECTOR_CHARS code
 * points (never mid surrogate pair).
 */
export function cleanSelector(s: string): string {
	const flat = s
		.replace(/[^\x20-\x7e\p{L}\p{N}]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	const points = Array.from(flat);
	return points.length > MAX_SELECTOR_CHARS
		? `${points.slice(0, MAX_SELECTOR_CHARS).join("")}...`
		: flat;
}

/** The element boxes out of a --dump-dom print, or null when the print holds none. */
export function parseElementBoxes(dom: string, token: string): ElementBox[] | null {
	if (!/^[0-9a-f]{16,}$/.test(token)) return null;
	const re = new RegExp(`<script[^>]*id="${boxesId(token)}"[^>]*>([\\s\\S]*?)</script>`, "g");
	let last: string | null = null;
	for (let m = re.exec(dom); m; m = re.exec(dom)) last = m[1];
	if (last === null) return null;
	try {
		const list = JSON.parse(last);
		if (!Array.isArray(list)) return null;
		const boxes: ElementBox[] = [];
		for (const e of list.slice(0, MAX_ELEMENTS)) {
			if (typeof e?.s !== "string") continue;
			if (![e.x, e.y, e.w, e.h].every((n) => typeof n === "number" && Number.isFinite(n))) continue;
			const s = cleanSelector(e.s);
			if (s) boxes.push({ s, x: e.x, y: e.y, w: e.w, h: e.h });
		}
		return boxes;
	} catch {
		return null;
	}
}

/**
 * Load the page (sanitised, with only elementProbe allowed to run) and return its visible
 * elements' boxes. Same offline flags as the screenshot. Null on any failure: the report then
 * goes out without names, exactly as before.
 */
export async function measureElements(
	chrome: string,
	htmlPath: string,
	width: number,
	height: number,
	dir: string,
): Promise<ElementBox[] | null> {
	try {
		const token = randomBytes(16).toString("hex");
		const copy = prepareSafeCopy(htmlPath, dir, elementProbe(token));
		const exit = await runChrome(
			chrome,
			chromeArgs(copy, null, width, height, path.join(dir, "profile-elements")),
			true,
			path.join(dir, "profile-elements"),
		);
		return parseElementBoxes(exit.stdout, token);
	} catch {
		return null;
	}
}

/** The element whose box best overlaps the band; on a tie the later (deeper) one. */
export function elementForBand(band: Band, elements: ElementBox[]): ElementBox | null {
	let best: ElementBox | null = null;
	let bestIou = MIN_NAME_IOU;
	for (const e of elements) {
		const iw = Math.min(band.x + band.w, e.x + e.w) - Math.max(band.x, e.x);
		const ih = Math.min(band.y + band.h, e.y + e.h) - Math.max(band.y, e.y);
		if (iw <= 0 || ih <= 0) continue;
		const inter = iw * ih;
		const iou = inter / (band.w * band.h + e.w * e.h - inter);
		if (iou >= bestIou) {
			best = e;
			bestIou = iou;
		}
	}
	return best;
}

const nameOf = (b: Band, elements: ElementBox[] | null | undefined): string => {
	const e = elements ? elementForBand(b, elements) : null;
	return e ? ` is ${e.s} (x ${e.x} y ${e.y} w ${e.w} h ${e.h})` : "";
};

/**
 * The report text for a reference measurement against a render measurement. `elements`
 * names the element behind each off band (#4204); null means the element pass failed.
 */
export function describeDiff(
	ref: LayoutMeasure,
	got: LayoutMeasure,
	similarity: number | null,
	elements?: ElementBox[] | null,
): string {
	const { pairs, extra } = pairBands(ref.bands, got.bands);
	const lines: string[] = [];
	lines.push(
		`Compared your render (${got.width}x${got.height} px) with the reference (${ref.width}x${ref.height} px). Offsets are yours minus the reference's: negative x or y means move it right or down.`,
	);
	if (similarity !== null)
		lines.push(`Pixel similarity ${similarity.toFixed(3)} (1.000 is identical).`);
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
		rows.push(
			`  ref y=${r.y} h=${r.h} x=${r.x} w=${r.w}${nameOf(g, elements)}: ${notes.join("; ")}`,
		);
	}
	for (const e of extra) {
		off++;
		rows.push(
			`  EXTRA band in your page at y=${e.y} h=${e.h} x=${e.x} w=${e.w}${nameOf(e, elements)}: the reference has nothing there`,
		);
	}
	if (off === 0) lines.push("Every content band is within 2px of the reference.");
	else {
		lines.push(`${off} of ${pairs.length + extra.length} bands are off:`);
		lines.push(...rows.slice(0, MAX_REPORT_ROWS));
		if (rows.length > MAX_REPORT_ROWS) lines.push(`  ...and ${rows.length - MAX_REPORT_ROWS} more`);
		lines.push(
			"Fix the largest offsets first (usually the earliest band moves everything below it), then run compare_layout again.",
		);
		if (elements === null)
			lines.push("Element names unavailable: the page's elements could not be measured.");
		else if (elements)
			lines.push(
				"Fix each named element's CSS with edit_file; never rewrite the whole page to fix an offset.",
			);
	}
	return lines.join("\n");
}

/** Render `html` and compare it with `reference`. Always resolves to a sentence. */
export async function compareLayout(
	htmlPath: string,
	referencePath: string,
	workspace: string = process.cwd(),
): Promise<string> {
	if (!fs.existsSync(htmlPath))
		return `compare_layout: ${htmlPath} does not exist. Write the page first.`;
	if (!fs.existsSync(referencePath))
		return `compare_layout: reference image ${referencePath} does not exist.`;
	const chrome = findChrome(process.env, workspace);
	if (!chrome)
		return "compare_layout: no headless browser is available here, so the page cannot be rendered. Your own Chrome is never launched; set EIGHT_CHROME_BIN to a headless Chromium to enable this.";
	// A browser started under a macOS seatbelt (the pilot's net-deny profile, a Claude session)
	// cannot reach the window server or LaunchServices: it aborts at startup and macOS shows the
	// person a crash report. Refuse up front. An explicit EIGHT_CHROME_BIN is the operator's call.
	const explicit = process.env.EIGHT_CHROME_BIN?.trim();
	if (chrome !== explicit) {
		const { hostSandboxBlocksBrowser } = await import("./eight-browser");
		if (hostSandboxBlocksBrowser())
			return "compare_layout: this process runs inside a macOS sandbox, where a browser cannot start (it would crash at launch), so the page cannot be rendered here. Check the HTML by hand.";
	}
	const ref = await measureLayout(referencePath);
	if (!ref) return "compare_layout: could not measure the reference image.";
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-compare-"));
	try {
		const out = path.join(tmp, "render.png");
		const width = Math.min(ref.width, MAX_VIEWPORT);
		const height = Math.min(ref.height, MAX_VIEWPORT);
		const elementsDir = path.join(tmp, "elements");
		fs.mkdirSync(elementsDir);
		// The element pass runs beside the screenshot and never fails the compare. Both are
		// awaited before `tmp` goes, so a failed screenshot never strands the element Chrome.
		const [renderError, elements] = await Promise.all([
			renderSafe(chrome, htmlPath, out, width, height, tmp).then(
				() => null,
				(e: unknown) => e,
			),
			measureElements(chrome, htmlPath, width, height, elementsDir),
		]);
		if (renderError) throw renderError;
		const got = await measureLayout(out);
		if (!got) return "compare_layout: your page rendered blank. Check the HTML.";
		const similarity = await pixelSimilarity(referencePath, out, ref.width, ref.height);
		return describeDiff(ref, got, similarity, elements);
	} catch (err) {
		return `compare_layout: could not render the page (${err instanceof Error ? err.message : String(err)}).`;
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}
