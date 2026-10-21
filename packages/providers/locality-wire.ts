/**
 * The wire point (#4607). Every model request in this process, whether it comes
 * from a turn, a failover, a summary, a judge, a title helper or a spawned
 * child, ends in a fetch. This wraps that fetch once, so one place:
 *   - refuses an inference request to an off-box host under local-only, before a
 *     byte is sent;
 *   - writes one ledger line per request (provider, local or cloud, tokens, exact
 *     bytes sent), never the text;
 *   - says once, on screen, when a request goes to the cloud and why.
 * An inference request is recognised by its path (chat/completions, messages,
 * api/chat ...), not by a provider list, so a new provider is covered the day it
 * is added. Loopback hosts are local; everything else is off this machine.
 */
import { type CallInfo, type RoutingPolicy, decideRoute, readPolicy, recordCall } from "./locality";

const INFERENCE_PATH =
	/\/(chat\/completions|completions|messages|responses|embeddings|api\/(chat|generate|embed|embeddings))\/?$|:(stream)?generate(content|message)\b/i;
const LOOPBACK = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)$/i;

export class LocalOnlyRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LocalOnlyRefusal";
	}
}

export interface WireDeps {
	policy: () => RoutingPolicy;
	/** Provider name for a host:port; default is the host. */
	nameOf: (hostPort: string, local: boolean) => string;
	record: (c: CallInfo) => unknown;
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
		policy: () => readPolicy(),
		nameOf: (hp, local) => namer(hp, local),
		record: (c) => recordCall(c),
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

const bodyBytes = (body: unknown): number => {
	if (typeof body === "string") return Buffer.byteLength(body);
	if (body instanceof Uint8Array) return body.byteLength;
	if (body instanceof ArrayBuffer) return body.byteLength;
	return 0;
};

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

function notice(policy: RoutingPolicy, provider: string): string {
	const why =
		policy === "cloud-first"
			? "policy is cloud-first"
			: "you picked it for this tab, or no local provider could serve this";
	return `Cloud call: ${provider}. Policy ${policy}: ${why}. See /privacy.`;
}

export function guardFetch(base: typeof fetch, deps: WireDeps): typeof fetch {
	const told = new Set<string>();
	const guarded = async (input: any, init?: any): Promise<Response> => {
		let url: URL;
		try {
			url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
		} catch {
			return base(input, init);
		}
		const method = String(init?.method ?? (typeof input === "object" && input.method) ?? "GET");
		if (method.toUpperCase() !== "POST" || !INFERENCE_PATH.test(url.pathname)) {
			return base(input, init);
		}
		const local = LOOPBACK.test(url.hostname);
		const provider = deps.nameOf(url.host, local);
		const policy = deps.policy();
		if (!local) {
			const d = decideRoute({ policy, provider, local: false, pickedForTab: true });
			if (d.action === "refuse") throw new LocalOnlyRefusal(d.message);
			const key = `${provider}|${policy}`;
			if (!told.has(key)) {
				told.add(key);
				deps.notify(notice(policy, provider));
			}
		}
		const sent = bodyBytes(init?.body);
		let done = false;
		const finish = (head: string, tail: string, respBytes: number) => {
			if (done) return;
			done = true;
			const u = usageFrom(head, tail);
			try {
				deps.record(
					u
						? { provider, local, tokensIn: u.in, tokensOut: u.out, bytesSent: sent }
						: {
								provider,
								local,
								tokensIn: Math.ceil(sent / 4),
								tokensOut: Math.ceil(respBytes / 4),
								bytesSent: sent,
								est: true,
							},
				);
			} catch {
				// the ledger must never break a call
			}
		};
		let res: Response;
		try {
			res = await base(input, init);
		} catch (e) {
			finish("", "", 0);
			throw e;
		}
		if (!res.body) {
			finish("", "", 0);
			return res;
		}
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
