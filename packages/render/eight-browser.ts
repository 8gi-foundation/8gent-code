/**
 * @8gent/render - native 8gent Browser backend (#3346 PR 3).
 *
 * The primary backend. 8gent Browser is already a Chromium, and its control
 * server (8gent-browser PR #50, src/main/control-server.ts) renders offscreen
 * from inside the agent sandbox, where a third-party Chrome cannot start.
 *
 * Protocol (consumed as-is, its trust boundary is 8SO-reviewed):
 *   - ws://127.0.0.1:7980 (EIGHT_BROWSER_CONTROL_PORT), no Origin header.
 *   - First frame { type: "auth", token }, token from ~/.8gent/browser-control.token.
 *     The token is read from the file and sent on the socket only: never argv,
 *     never a log line, and redacted from any error text we pass on.
 *   - Then { id, cmd, args } -> { id, ok, result | error }.
 *   - render.open {url,width,height} -> {renderId, timelines}; render.seek
 *     {renderId, composition, t}; render.capture -> {png: base64}; render.close.
 *   - It only loads files under its render roots (~/.8gent/creative,
 *     ~/.8gent/renders) with no dot segments, so decks are written there.
 *
 * Decks have no timeline, so the capture copy registers one (DECK_TIMELINE_SHIM):
 * one render.open per deck, then show(k) is render.seek to t = k.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { Availability, RenderBackend, RenderSession, RenderSize } from "./backend";

type Env = Record<string, string | undefined>;

/** The composition id a deck's capture copy registers and show(k) seeks. */
export const DECK_TIMELINE = "deck";

/**
 * Appended to a deck's capture copy after its slide-switching script. Seeking to t
 * sets #slide=round(t) and dispatches hashchange synchronously, so the deck2video
 * capture shim's listener has switched the slide before the browser waits for paint.
 */
export const DECK_TIMELINE_SHIM = `<script>(function(){window.__timelines=window.__timelines||{};window.__timelines.${DECK_TIMELINE}={seek:function(t){location.hash="slide="+Math.round(t);window.dispatchEvent(new HashChangeEvent("hashchange"))},duration:function(){return document.querySelectorAll(".slide").length}};})();</script>`;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
/** render-host.ts caps: dimensions 16-7680. */
const MIN_DIM = 16;

export interface EightBrowserOptions {
	env?: Env;
	port?: number;
	tokenPath?: string;
	/** Where documents must live. Defaults to ~/.8gent/renders. */
	rendersRoot?: string;
	connectTimeoutMs?: number;
	/** render.open waits up to 50 s for load and fonts on the server side. */
	callTimeoutMs?: number;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One authenticated control connection. */
class ControlClient {
	private ws: WebSocket | null = null;
	private seq = 0;
	private token = "";
	private readonly pending = new Map<
		number,
		{ ok: (v: unknown) => void; err: (e: Error) => void }
	>();

	constructor(
		private readonly port: number,
		private readonly tokenPath: string,
		private readonly connectTimeoutMs: number,
		private readonly callTimeoutMs: number,
	) {}

	/** Any text leaving this client goes through here, so the token cannot. */
	private clean(msg: string): string {
		return this.token ? msg.split(this.token).join("[token]") : msg;
	}

	async connect(): Promise<void> {
		if (!existsSync(this.tokenPath))
			throw new Error(
				`no control token at ${this.tokenPath}: is 8gent Browser installed and running?`,
			);
		this.token = readFileSync(this.tokenPath, "utf8").trim();
		const url = `ws://127.0.0.1:${this.port}`;
		const ws = new WebSocket(url);
		this.ws = ws;
		await new Promise<void>((ok, err) => {
			const fail = (e: Error) => {
				clearTimeout(timer);
				err(e);
			};
			const timer = setTimeout(
				() => fail(new Error(`${url} did not answer in ${this.connectTimeoutMs} ms`)),
				this.connectTimeoutMs,
			);
			ws.onerror = () => fail(new Error(`cannot reach ${url} (is 8gent Browser running?)`));
			ws.onclose = () => fail(new Error(`${url} closed the connection during auth`));
			ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: this.token }));
			ws.onmessage = (ev) => {
				const m = JSON.parse(String(ev.data)) as { type?: string; error?: string };
				if (m.type === "auth_ok") {
					clearTimeout(timer);
					ws.onmessage = (e2) => this.onMessage(String(e2.data));
					ws.onclose = () => this.failAll(new Error("8gent Browser closed the control connection"));
					ws.onerror = null;
					ok();
				} else if (m.type === "error")
					fail(new Error(`auth refused: ${this.clean(String(m.error))}`));
			};
		});
	}

	private onMessage(raw: string): void {
		const m = JSON.parse(raw) as { id?: number; ok?: boolean; result?: unknown; error?: string };
		const p = typeof m.id === "number" ? this.pending.get(m.id) : undefined;
		if (!p) return;
		this.pending.delete(m.id as number);
		if (m.ok) p.ok(m.result);
		else p.err(new Error(this.clean(String(m.error ?? "unknown error"))));
	}

	private failAll(e: Error): void {
		for (const p of this.pending.values()) p.err(e);
		this.pending.clear();
	}

	call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
		const ws = this.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN)
			return Promise.reject(new Error("control connection is not open"));
		const id = ++this.seq;
		return new Promise<T>((ok, err) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				err(new Error(`${cmd} timed out after ${this.callTimeoutMs} ms`));
			}, this.callTimeoutMs);
			this.pending.set(id, {
				ok: (v) => {
					clearTimeout(timer);
					ok(v as T);
				},
				err: (e) => {
					clearTimeout(timer);
					err(e);
				},
			});
			ws.send(JSON.stringify({ id, cmd, args }));
		});
	}

	close(): void {
		this.failAll(new Error("control connection closed"));
		try {
			this.ws?.close();
		} catch {
			// Already gone.
		}
		this.ws = null;
	}
}

class EightBrowserSession implements RenderSession {
	private closed = false;

	constructor(
		private readonly client: ControlClient,
		private readonly renderId: string,
	) {}

	async show(slide: number): Promise<void> {
		if (this.closed) throw new Error("render session is closed");
		await this.client.call("render.seek", {
			renderId: this.renderId,
			composition: DECK_TIMELINE,
			t: slide,
		});
	}

	async capture(): Promise<Uint8Array> {
		if (this.closed) throw new Error("render session is closed");
		const r = await this.client.call<{ png?: string }>("render.capture", {
			renderId: this.renderId,
		});
		const bytes = Buffer.from(String(r?.png ?? ""), "base64");
		if (!PNG_MAGIC.every((b, i) => bytes[i] === b))
			throw new Error("render.capture did not return a PNG");
		return bytes;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.client.call("render.close", { renderId: this.renderId }).catch(() => {});
		this.client.close();
	}
}

export class EightBrowserBackend implements RenderBackend {
	readonly name = "8gent-browser" as const;
	private readonly port: number;
	private readonly tokenPath: string;
	readonly rendersRoot: string;
	private readonly connectTimeoutMs: number;
	private readonly callTimeoutMs: number;

	constructor(o: EightBrowserOptions = {}) {
		const env = o.env ?? process.env;
		const envPort = Number(env.EIGHT_BROWSER_CONTROL_PORT);
		this.port =
			o.port ?? (Number.isInteger(envPort) && envPort > 0 && envPort < 65536 ? envPort : 7980);
		this.tokenPath = o.tokenPath ?? join(homedir(), ".8gent", "browser-control.token");
		this.rendersRoot = resolve(o.rendersRoot ?? join(homedir(), ".8gent", "renders"));
		this.connectTimeoutMs = o.connectTimeoutMs ?? 5000;
		this.callTimeoutMs = o.callTimeoutMs ?? 90_000;
	}

	private client(): ControlClient {
		return new ControlClient(this.port, this.tokenPath, this.connectTimeoutMs, this.callTimeoutMs);
	}

	/** Refuse what the browser would refuse, with a reason that says where decks go. */
	private servable(htmlPath: string): string {
		const abs = resolve(htmlPath);
		if (!existsSync(abs)) throw new Error(`no such document: ${abs}`);
		const root = existsSync(this.rendersRoot) ? realpathSync(this.rendersRoot) : this.rendersRoot;
		const real = realpathSync(abs);
		if (!real.startsWith(root + sep))
			throw new Error(
				`8gent Browser only renders documents under ${this.rendersRoot}; write the capture copy there`,
			);
		if (
			relative(root, real)
				.split(sep)
				.some((s) => s.startsWith("."))
		)
			throw new Error("8gent Browser never serves a dot file or dot folder");
		// The browser compares against its roots' real paths, so send the real path.
		return real;
	}

	/** Auth, render.open of a tiny page under the root, render.close. The path that renders, nothing else. */
	async available(): Promise<Availability> {
		const dir = join(this.rendersRoot, `probe-${process.pid}-${Date.now()}`);
		const c = this.client();
		try {
			await c.connect();
			mkdirSync(dir, { recursive: true });
			const page = join(dir, "probe.html");
			writeFileSync(page, "<!doctype html><html><body></body></html>");
			const r = await c.call<{ renderId: string }>("render.open", {
				url: page,
				width: MIN_DIM,
				height: MIN_DIM,
			});
			await c.call("render.close", { renderId: r.renderId });
			return { ok: true };
		} catch (e) {
			return { ok: false, reason: errText(e) };
		} finally {
			c.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}

	async open(htmlPath: string, size: RenderSize): Promise<RenderSession> {
		const url = this.servable(htmlPath);
		const c = this.client();
		let renderId: string | null = null;
		try {
			await c.connect();
			const r = await c.call<{ renderId: string; timelines?: string[] }>("render.open", {
				url,
				width: size.width,
				height: size.height,
			});
			renderId = r.renderId;
			if (!r.timelines?.includes(DECK_TIMELINE))
				throw new Error(
					`document registers no window.__timelines.${DECK_TIMELINE}; append DECK_TIMELINE_SHIM to the capture copy`,
				);
			return new EightBrowserSession(c, renderId);
		} catch (e) {
			if (renderId) await c.call("render.close", { renderId }).catch(() => {});
			c.close();
			throw e;
		}
	}
}
