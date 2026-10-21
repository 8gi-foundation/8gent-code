/**
 * The wire point (#4607). Model and network requests sent through 8gent's own
 * HTTP client (the process fetch) pass here, whether they come from a turn, a
 * failover, a summary, a judge, a title helper or an in-process child. One
 * wrapper:
 *   - under local-only refuses any request other than GET or HEAD to a host that
 *     is not this machine (loopback, or routing.localHosts), whatever the path,
 *     and refuses a redirect to such a host;
 *   - writes one ledger line per off-box request and per local model call at send
 *     time, then the real token counts when the reply finishes;
 *   - says once, on screen, when a request goes to the cloud and why.
 * It does NOT cover run_command tools such as curl, clients that do not use
 * fetch, or child processes that do not load it (see LOCAL_ONLY_GAPS).
 */
import {
	type CallInfo,
	type LedgerEntry,
	type PolicyState,
	decideRoute,
	isLocalHost,
	readPolicyState,
	recordCall,
	updateCall,
} from "./locality";

/** Labels a ledger line as a model call. It is not the gate: local-only refuses by method and host. */
const INFERENCE_PATH =
	/\/(chat\/completions|completions|messages|responses|embeddings|predictions|api\/(chat|generate|embed|embeddings))\/?$|:(stream)?generate(content|message)\b/i;

export class LocalOnlyRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LocalOnlyRefusal";
	}
}

export interface WireDeps {
	state: () => PolicyState;
	/** Provider name for a host:port; default is the host. */
	nameOf: (hostPort: string, local: boolean) => string;
	record: (c: CallInfo) => LedgerEntry | null;
	update: (
		id: string | undefined,
		usage: { tokensIn: number; tokensOut: number; est?: boolean },
	) => void;
	notify: (message: string) => void;
}

let namer: WireDeps["nameOf"] = (hostPort) => hostPort;
/** providers/index.ts maps host:port to the registry's provider name. */
export function setProviderNamer(fn: WireDeps["nameOf"]): void {
	namer = fn;
}

type NoticeListener = (message: string) => void;
const noticeListeners = new Set<NoticeListener>();
/** The TUI prints these as system lines. */
export function onCloudNotice(fn: NoticeListener): () => void {
	noticeListeners.add(fn);
	return () => noticeListeners.delete(fn);
}

export function defaultWireDeps(): WireDeps {
	return {
		state: () => readPolicyState(),
		nameOf: (hp, local) => namer(hp, local),
		record: (c) => recordCall(c),
		update: (id, u) => updateCall(id, u),
		notify: (m) => {
			for (const fn of noticeListeners) {
				try {
					fn(m);
				} catch {
					// a listener must never break a call
				}
			}
		},
	};
}

/** Request body size. known=false when it cannot be measured without reading a stream. */
export async function bodySize(
	body: unknown,
	input?: unknown,
): Promise<{ bytes: number; known: boolean }> {
	if (body === undefined || body === null) {
		if (typeof Request !== "undefined" && input instanceof Request && input.body) {
			try {
				return { bytes: (await input.clone().arrayBuffer()).byteLength, known: true };
			} catch {
				return { bytes: 0, known: false };
			}
		}
		return { bytes: 0, known: true };
	}
	if (typeof body === "string") return { bytes: Buffer.byteLength(body), known: true };
	if (ArrayBuffer.isView(body)) return { bytes: body.byteLength, known: true };
	if (body instanceof ArrayBuffer) return { bytes: body.byteLength, known: true };
	if (typeof Blob !== "undefined" && body instanceof Blob) return { bytes: body.size, known: true };
	if (body instanceof URLSearchParams) {
		return { bytes: Buffer.byteLength(body.toString()), known: true };
	}
	if (typeof FormData !== "undefined" && body instanceof FormData) {
		let n = 0;
		for (const [k, v] of body.entries() as Iterable<[string, string | Blob]>) {
			n += Buffer.byteLength(k) + (typeof v === "string" ? Buffer.byteLength(v) : v.size);
		}
		return { bytes: n, known: true };
	}
	return { bytes: 0, known: false };
}

const lastInt = (text: string, key: string): number | null => {
	const re = new RegExp(`"${key}"\\s*:\\s*(\\d+)`, "g");
	let m: RegExpExecArray | null;
	let v: number | null = null;
	// biome-ignore lint/suspicious/noAssignInExpressions: scan loop
	while ((m = re.exec(text))) v = Number(m[1]);
	return v;
};

/** Usage from the end (and start) of a reply body. Null when the endpoint sent none. */
export function usageFrom(head: string, tail: string): { in: number; out: number } | null {
	const tin =
		lastInt(tail, "prompt_tokens") ??
		lastInt(tail, "input_tokens") ??
		lastInt(tail, "prompt_eval_count") ??
		lastInt(head, "input_tokens") ??
		lastInt(head, "prompt_tokens");
	const tout =
		lastInt(tail, "completion_tokens") ??
		lastInt(tail, "output_tokens") ??
		lastInt(tail, "eval_count");
	if (tin === null && tout === null) return null;
	return { in: tin ?? 0, out: tout ?? 0 };
}

const HEAD = 16 * 1024;
const TAIL = 64 * 1024;
const MAX_HOPS = 5;
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function notice(policy: string, provider: string): string {
	const why =
		policy === "cloud-first"
			? "policy is cloud-first"
			: "you picked it for this tab, or no local provider could serve this";
	return `Cloud call: ${provider}. Policy ${policy}: ${why}. See /privacy.`;
}

export function guardFetch(base: typeof fetch, deps: WireDeps): typeof fetch {
	const told = new Set<string>();
	const tell = (key: string, msg: string) => {
		if (told.has(key)) return;
		told.add(key);
		deps.notify(msg);
	};

	const guarded = async (input: any, init?: any): Promise<Response> => {
		let url: URL;
		try {
			url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
		} catch {
			return base(input, init);
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") return base(input, init);
		const reqMethod =
			typeof input === "object" && input && "method" in input ? input.method : undefined;
		const method = String(init?.method ?? reqMethod ?? "GET").toUpperCase();
		const readonly = method === "GET" || method === "HEAD";
		const st = deps.state();
		const local = isLocalHost(url.hostname, url.port, st.localHosts);
		const provider = deps.nameOf(url.host, local);
		const label = INFERENCE_PATH.test(url.pathname);
		if (st.why && !readonly) tell(`why|${st.why}`, st.why);

		if (st.policy === "local-only" && !local && !readonly) {
			const d = decideRoute({
				policy: "local-only",
				provider,
				local: false,
				pickedForTab: true,
				why: st.why,
			});
			throw new LocalOnlyRefusal(d.action === "refuse" ? d.message : "refused");
		}
		if (!local && label && st.policy !== "local-only") {
			tell(`${provider}|${st.policy}`, notice(st.policy, provider));
		}

		// Count: every off-box write, and every local model call. Written now, so a reply
		// that is never read is still counted; the real usage is appended when it ends.
		let entry: LedgerEntry | null = null;
		const counted = (!local && !readonly) || (local && label && !readonly);
		const sent = counted ? await bodySize(init?.body, input) : { bytes: 0, known: true };
		if (counted) {
			entry = deps.record({
				provider,
				local,
				tokensIn: Math.ceil(sent.bytes / 4),
				tokensOut: 0,
				bytesSent: sent.bytes,
				est: true,
				...(label ? {} : { kind: "other" as const }),
			});
		}
		const modelCall = counted && label;

		const finish = (head: string, tail: string, respBytes: number) => {
			if (!entry || !modelCall) return;
			const u = usageFrom(head, tail);
			deps.update(
				entry.id,
				u
					? { tokensIn: u.in, tokensOut: u.out }
					: { tokensIn: Math.ceil(sent.bytes / 4), tokensOut: Math.ceil(respBytes / 4), est: true },
			);
			entry = null;
		};

		let res: Response;
		try {
			res =
				st.policy === "local-only"
					? await followLocalOnly(base, input, init, url, method, st, deps, provider)
					: await base(input, init);
		} catch (e) {
			finish("", "", 0);
			throw e;
		}
		if (!res.body) {
			finish("", "", 0);
			return res;
		}
		if (!modelCall) return res;
		const reader = res.body.getReader();
		const dec = new TextDecoder();
		let head = "";
		let tail = "";
		let total = 0;
		const stream = new ReadableStream<Uint8Array>({
			async pull(ctl) {
				try {
					const { done: end, value } = await reader.read();
					if (end) {
						finish(head, tail, total);
						ctl.close();
						return;
					}
					total += value.byteLength;
					const text = dec.decode(value, { stream: true });
					if (head.length < HEAD) head += text.slice(0, HEAD - head.length);
					tail = (tail + text).slice(-TAIL);
					ctl.enqueue(value);
				} catch (e) {
					finish(head, tail, total);
					ctl.error(e);
				}
			},
			cancel(reason) {
				finish(head, tail, total);
				return reader.cancel(reason);
			},
		});
		return new Response(stream, {
			status: res.status,
			statusText: res.statusText,
			headers: res.headers,
		});
	};
	return guarded as unknown as typeof fetch;
}

/**
 * local-only: redirects are followed here, by hand, so a redirect cannot carry a request
 * (or a body) to a host that is not this machine. Reads stay free: a GET may go anywhere.
 */
async function followLocalOnly(
	base: typeof fetch,
	input: any,
	init: any,
	first: URL,
	method0: string,
	st: PolicyState,
	deps: WireDeps,
	provider: string,
): Promise<Response> {
	// A caller that asked to handle redirects itself (or to have them fail) keeps that.
	const asked =
		init?.redirect ??
		(input instanceof Request && input.redirect !== "follow" ? input.redirect : undefined);
	if (asked === "manual" || asked === "error") return base(input, init);
	let cur = first;
	let method = method0;
	let curInit: any = { ...(init ?? {}), redirect: "manual" };
	let curInput: any = input;
	for (let hop = 0; hop <= MAX_HOPS; hop++) {
		const res = await base(curInput, curInit);
		const loc = res.headers.get("location");
		if (!REDIRECTS.has(res.status) || !loc) return res;
		let next: URL;
		try {
			next = new URL(loc, cur);
		} catch {
			return res;
		}
		const toGet =
			res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST");
		const nextMethod = toGet ? "GET" : method;
		const nextReadonly = nextMethod === "GET" || nextMethod === "HEAD";
		if (!isLocalHost(next.hostname, next.port, st.localHosts) && !nextReadonly) {
			const d = decideRoute({
				policy: "local-only",
				provider: deps.nameOf(next.host, false) || provider,
				local: false,
				pickedForTab: true,
				why: st.why,
			});
			throw new LocalOnlyRefusal(d.action === "refuse" ? d.message : "refused");
		}
		await res.body?.cancel().catch(() => {});
		// As native fetch does: credentials do not follow a redirect to another origin.
		if (next.origin !== cur.origin) {
			const h = new Headers(
				curInit.headers ?? (curInput instanceof Request ? curInput.headers : undefined),
			);
			for (const k of CREDENTIAL_HEADERS) h.delete(k);
			curInit.headers = h;
		}
		cur = next;
		method = nextMethod;
		curInput = next.href;
		curInit = { ...curInit, method: nextMethod, redirect: "manual" };
		if (toGet) curInit.body = undefined;
	}
	throw new Error("Too many redirects.");
}

const INSTALLED = Symbol.for("8gent.locality.guard");

/** Wrap the process fetch once. Skipped under bun test unless forced. */
export function installLocalityGuard(force = false): void {
	if (process.env.NODE_ENV === "test" && !force) return;
	const g = globalThis as any;
	if (g.fetch?.[INSTALLED]) return;
	const wrapped = guardFetch(g.fetch.bind(globalThis), defaultWireDeps());
	(wrapped as any)[INSTALLED] = true;
	g.fetch = wrapped;
}
