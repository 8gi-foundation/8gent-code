/**
 * 8gent Code - 8gent Browser driver for browser_open / browser_state / browser_task (#3589).
 *
 * Talks to 8gent Browser's token-gated local control channel (ws://127.0.0.1:7980, token in
 * ~/.8gent/browser-control.token), the same channel ~/.8gent/bin/8b-web uses. Concepts imported
 * from the 8gent-computer CUA (src/main/cu/), rebuilt here, not copied:
 *   - action spec: a closed action vocabulary with hard caps (actionSpec.ts validateAction)
 *   - dry run: the whole plan is validated and resolved against the current page before the
 *     first act; one bad step refuses the plan with nothing touched (dryRun.ts)
 *   - verify after act: re-read the page after every step; a type that did not land is retried
 *     once, then stops the plan (verify.ts). Clicks are never retried: a retried toggle undoes itself.
 *   - action log: one row per step, typed text logged as length only (actionLog.ts)
 * Only tabs this process opened are driven, never the user's own tabs.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type BrowserCall = (cmd: string, args?: Record<string, unknown>) => Promise<any>;
export type BrowserAction =
	| { action: "open"; url: string }
	| { action: "left_click"; index?: number; selector?: string }
	| { action: "type"; selector: string; text: string }
	| { action: "wait_for"; selector: string; timeout_ms?: number }
	| { action: "scroll"; dy: number };

export const BROWSER_ACTION_KINDS = ["open", "left_click", "type", "wait_for", "scroll"] as const;
const LIMITS = { maxTypeLength: 4_000, maxWaitMs: 10_000, maxScroll: 10_000, maxSteps: 25 };
const DESTRUCTIVE = /\b(delete|remove|destroy|pay|purchase|buy|transfer|unsubscribe)\b/i;

type Check<T> = { ok: true; action: T } | { ok: false; error: string };

export function validateBrowserAction(raw: unknown): Check<BrowserAction> {
	if (!raw || typeof raw !== "object") return { ok: false, error: "action must be an object" };
	const a = raw as Record<string, unknown>;
	const sel = typeof a.selector === "string" && a.selector.trim() ? a.selector : undefined;
	switch (a.action) {
		case "open":
			if (typeof a.url !== "string" || !/^https?:\/\//.test(a.url)) return { ok: false, error: "open.url must be http(s)" };
			return { ok: true, action: { action: "open", url: a.url } };
		case "left_click": {
			const index = Number.isInteger(a.index) && (a.index as number) >= 0 ? (a.index as number) : undefined;
			if (index === undefined && !sel) return { ok: false, error: "left_click needs index or selector" };
			return { ok: true, action: { action: "left_click", index, selector: sel } };
		}
		case "type":
			if (!sel || typeof a.text !== "string") return { ok: false, error: "type needs selector and text" };
			if (a.text.length > LIMITS.maxTypeLength) return { ok: false, error: `type.text > ${LIMITS.maxTypeLength} chars` };
			return { ok: true, action: { action: "type", selector: sel, text: a.text } };
		case "wait_for": {
			if (!sel) return { ok: false, error: "wait_for needs selector" };
			const t = typeof a.timeout_ms === "number" ? Math.min(Math.max(a.timeout_ms, 0), LIMITS.maxWaitMs) : 5_000;
			return { ok: true, action: { action: "wait_for", selector: sel, timeout_ms: t } };
		}
		case "scroll": {
			if (typeof a.dy !== "number" || !Number.isFinite(a.dy)) return { ok: false, error: "scroll.dy must be a number" };
			return { ok: true, action: { action: "scroll", dy: Math.max(-LIMITS.maxScroll, Math.min(a.dy, LIMITS.maxScroll)) } };
		}
	}
	return { ok: false, error: `unknown action kind: ${String(a.action)}` };
}

/** WebSocket transport: one authenticated round trip per command, as 8b-web does. */
export function wsTransport(opts: { port?: number; tokenFile?: string } = {}): BrowserCall {
	return (cmd, args = {}) => {
		const port = opts.port ?? (Number(process.env.EIGHT_BROWSER_CONTROL_PORT) || 7980);
		return new Promise((resolve, reject) => {
			let token: string;
			try {
				token = readFileSync(opts.tokenFile ?? join(homedir(), ".8gent", "browser-control.token"), "utf8").trim();
			} catch {
				return reject(new Error("8gent Browser control token not found; is 8gent Browser installed and running?"));
			}
			const ws = new WebSocket(`ws://127.0.0.1:${port}`);
			const timer = setTimeout(() => (ws.close(), reject(new Error(`8gent Browser timed out on ${cmd}`))), 30_000);
			const done = (fn: () => void) => (clearTimeout(timer), ws.close(), fn());
			ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token }));
			ws.onerror = () => done(() => reject(new Error(`8gent Browser not reachable on 127.0.0.1:${port}`)));
			ws.onmessage = (ev) => {
				const m = JSON.parse(String(ev.data));
				if (m.type === "auth_ok") return ws.send(JSON.stringify({ id: 1, cmd, args }));
				if (m.type === "error") return done(() => reject(new Error(m.error)));
				if (m.id === 1) done(() => (m.ok ? resolve(m.result) : reject(new Error(m.error))));
			};
		});
	};
}
export const wsCall: BrowserCall = wsTransport();

type Rect = { x: number; y: number; w: number; h: number };
type El = { index: number; tag: string; text: string; checked?: boolean; hidden?: boolean };
/** page.query's text form: whitespace collapsed, 120 chars (8gent-browser automation.ts queryElements). */
const clipped = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 120);

export function createEightBrowser(call: BrowserCall = wsCall, opts: { settleMs?: number } = {}) {
	const settle = opts.settleMs ?? 400;
	const owned = new Set<string>();
	const typed = new Set<string>(); // clipped forms of text typed this session; page.query echoes input values
	let current: string | undefined;
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	const elements = async (tabId: string): Promise<El[]> => {
		const r = await call("page.query", { tabId });
		// page.query has no checked flag; match :checked elements back by rect so a toggle click is observable.
		const on = new Set(((await call("page.query", { tabId, selector: ":checked" }))?.elements ?? []).map((e: { rect?: Rect }) => JSON.stringify(e.rect)));
		return (r?.elements ?? []).map((e: El & { rect?: Rect; visible?: boolean }) => {
			const el: El = { index: e.index, tag: e.tag, text: e.text };
			if (e.visible === false) el.hidden = true; // kept for stable indices, never rendered (hidden csrf values)
			if (e.rect && on.has(JSON.stringify(e.rect))) el.checked = true;
			return el;
		});
	};
	const observe = async (tabId: string) => {
		const snap = (await call("page.read", { tabId }))?.snapshot ?? {};
		const els = await elements(tabId);
		const sig = createHash("sha256").update(JSON.stringify([snap.url, snap.title, snap.text, els])).digest("hex").slice(0, 16);
		return { url: String(snap.url ?? ""), title: String(snap.title ?? ""), text: String(snap.text ?? ""), els, sig };
	};
	const own = (tabId?: string): string => {
		const id = tabId ?? current;
		if (!id || !owned.has(id)) throw new Error(`tab ${id ?? "(none)"} was not opened by 8gent; call browser_open first`);
		return id;
	};
	const render = (tab: string, o: Awaited<ReturnType<typeof observe>>) =>
		JSON.stringify({ tab, url: o.url, title: o.title, elements: o.els.filter((e) => !e.hidden).map((e) => `[${e.index}] ${e.tag}${e.checked ? " (checked)" : ""} ${typed.has(e.text) ? `(typed, ${e.text.length} chars)` : e.text}`.trim()), text: o.text.slice(0, 3_000) });
	const clickGuard = (els: El[], a: { index?: number }): string | null => {
		if (a.index === undefined) return null;
		const el = els[a.index];
		if (!el) return `index ${a.index} out of range (${els.length} elements)`;
		if (el.hidden) return `index ${a.index} is a hidden element`;
		return DESTRUCTIVE.test(el.text) ? `refusing destructive click on "${el.text}"; ask the user to do it` : null;
	};

	async function open(url: string): Promise<string> {
		const v = validateBrowserAction({ action: "open", url });
		if (!v.ok) return `browser_open failed: ${v.error}`;
		const r = await call("tab.open", { url });
		owned.add((current = String(r.id)));
		await call("page.waitFor", { tabId: current, selector: "body", timeoutMs: 10_000 });
		return render(current, await observe(current));
	}

	async function state(tabId?: string): Promise<string> {
		try {
			const id = own(tabId);
			return render(id, await observe(id));
		} catch (e) {
			return `browser_state failed: ${(e as Error).message}`;
		}
	}

	async function run(raw: unknown[], tabId?: string): Promise<string> {
		const fail = (error: string, steps: unknown[] = []) => JSON.stringify({ ok: false, error, steps });
		let id: string;
		try {
			id = own(tabId);
		} catch (e) {
			return fail((e as Error).message);
		}
		if (!Array.isArray(raw) || raw.length === 0 || raw.length > LIMITS.maxSteps) return fail(`actions must be 1..${LIMITS.maxSteps} steps`);
		// Dry run: validate every step, resolve clicks up to the first page-changing step.
		const plan: BrowserAction[] = [];
		let before = await observe(id);
		for (const [i, r] of raw.entries()) {
			const v = validateBrowserAction(r);
			if (!v.ok) return fail(`dry run: step ${i}: ${v.error}`);
			plan.push(v.action);
		}
		for (const [i, a] of plan.entries()) {
			if (a.action === "open") break;
			if (a.action !== "left_click") continue;
			const err = clickGuard(before.els, a);
			if (err) return fail(`dry run: step ${i}: ${err}`);
			break; // after the first click the page may change; later clicks are re-resolved live
		}
		const steps: Record<string, unknown>[] = [];
		for (const [i, a] of plan.entries()) {
			const row: Record<string, unknown> = { step: i, action: a.action, attempts: 1 };
			if (a.action === "type") {
				row.selector = a.selector;
				row.text_len = a.text.length;
				if (a.text) typed.add(clipped(a.text));
				for (let n = 1; n <= 2; n++) {
					row.attempts = n;
					const r = await call("page.type", { tabId: id, selector: a.selector, text: a.text });
					if (r?.ok === false) row.error = r.error;
					const got = (await call("page.query", { tabId: id, selector: a.selector }))?.elements?.[0]?.text;
					row.verified = got === clipped(a.text);
					if (row.verified) break;
				}
				row.ok = row.verified;
			} else if (a.action === "left_click") {
				const err = clickGuard(before.els, a);
				if (err) return fail(`step ${i}: ${err}`, steps);
				const t = a.index !== undefined ? before.els[a.index]?.text : a.selector;
				row.target = t !== undefined && typed.has(t) ? "(typed field)" : t;
				const r = await call("page.click", { tabId: id, index: a.index, selector: a.selector });
				row.ok = r?.ok !== false;
				if (!row.ok) row.error = r.error;
				let after = await observe(id);
				for (let n = 0; row.ok && after.sig === before.sig && n < 3; n++) after = (await sleep(settle), await observe(id));
				row.verified = row.ok && after.sig !== before.sig; // no visible change is reported, never retried
				before = after;
				steps.push(row);
				if (!row.ok) return fail(`step ${i}: click failed`, steps);
				continue;
			} else if (a.action === "open") {
				await call("nav.go", { tabId: id, url: a.url });
				row.verified = row.ok = (await call("page.waitFor", { tabId: id, selector: "body", timeoutMs: 10_000 }))?.found === true;
			} else if (a.action === "wait_for") {
				row.verified = row.ok = (await call("page.waitFor", { tabId: id, selector: a.selector, timeoutMs: a.timeout_ms }))?.found === true;
			} else {
				const r = await call("page.scroll", { tabId: id, dy: a.dy });
				row.verified = row.ok = r?.ok !== false;
			}
			steps.push(row);
			if (!row.ok) return fail(`step ${i}: ${a.action} not verified`, steps);
			before = await observe(id);
		}
		return JSON.stringify({ ok: true, steps, page: JSON.parse(render(id, before)) });
	}

	/** Screenshot an owned tab to `path` (default: 8gent Browser's own ~/.8gent/browser-shots file). */
	async function screenshot(path?: string, tabId?: string): Promise<string> {
		try {
			const r = await call("page.screenshot", { tabId: own(tabId) });
			if (r?.ok === false) return `browser_screenshot failed: ${r.error}`;
			if (!path) return String(r?.savedTo ?? "browser_screenshot failed: 8gent Browser saved no file");
			writeFileSync(path, Buffer.from(String(r?.dataUrl ?? "").replace(/^data:image\/\w+;base64,/, ""), "base64"));
			return path;
		} catch (e) {
			return `browser_screenshot failed: ${(e as Error).message}`;
		}
	}

	return { open, state, run, screenshot };
}
