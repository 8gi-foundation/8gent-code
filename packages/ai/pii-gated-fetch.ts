/**
 * PII gate for the AI-SDK path (cloud-egress boundary).
 *
 * The main loop, compaction, the task router, auto-commit and memory all reach a
 * model through createModel() (./providers.ts), whose requests leave through one
 * fetch. ProviderManager.chat() anonymized its own requests, but that fetch did
 * not, so a cloud turn sent message text, tool results and the system prompt raw.
 *
 * This wraps that fetch for a cloud endpoint with the same rule as
 * ProviderManager.chat(): every message's text, every tool-call argument, the
 * system prompt and tool results are anonymized with one shared pseudonym map,
 * the result is verified clean, and only then sent. Anything that cannot be
 * proven clean (an anonymizer error, PII still present, a body that cannot be
 * read) is refused before the request leaves: fail closed, never raw. The reply
 * is restored, JSON or SSE stream, so the person and the tools see real values.
 *
 * Local endpoints are not wrapped (createModel decides with isCloudProvider).
 */

import * as anonymizer from "../permissions/pii-anonymizer";

/** One text slot in the outbound body: read it, then write its clean value back. */
interface Slot {
	get: () => string;
	set: (v: string) => void;
}

const FAIL =
	"PII gate fail-closed: could not produce a verified-clean payload. Refusing to send to cloud.";

/** Every text the model will read, from an OpenAI-compatible chat body. */
function slotsOf(body: { messages?: unknown }): {
	slots: Slot[];
	fixed: string[];
	args: () => string[];
} {
	const slots: Slot[] = [];
	// Ids and names are not anonymized; PII in them fails closed (same as ProviderManager).
	const fixed: string[] = [];
	const fns: Record<string, unknown>[] = [];
	const leaf = (holder: Record<string, unknown> | unknown[], key: string | number): void => {
		const v = (holder as Record<string | number, unknown>)[key];
		if (typeof v === "string" || typeof v === "number") {
			slots.push({
				get: () => String(v),
				set: (s) => {
					(holder as Record<string | number, unknown>)[key] =
						typeof v === "number" && s === String(v) ? v : s;
				},
			});
		} else if (v && typeof v === "object") {
			for (const k of Array.isArray(v) ? v.keys() : Object.keys(v))
				leaf(v as Record<string, unknown>, k);
		}
	};
	if (!Array.isArray(body.messages)) throw new Error("no messages array");
	for (const m of body.messages as Record<string, unknown>[]) {
		if (typeof m.content === "string") leaf(m, "content");
		else if (Array.isArray(m.content)) {
			for (const part of m.content as Record<string, unknown>[])
				if (typeof part.text === "string") leaf(part, "text");
		}
		if (typeof m.reasoning_content === "string") leaf(m, "reasoning_content");
		if (typeof m.name === "string") fixed.push(m.name);
		if (typeof m.tool_call_id === "string") fixed.push(m.tool_call_id);
		for (const tc of (m.tool_calls as Record<string, unknown>[] | undefined) ?? []) {
			const fn = tc.function as Record<string, unknown>;
			fixed.push(String(tc.id ?? ""), String(fn?.name ?? ""));
			fns.push(fn);
			// Arguments travel as a JSON string: mask each leaf, not the string, so a
			// number stays a number and the JSON still parses (#3547).
			let args: unknown;
			try {
				args = JSON.parse(String(fn.arguments ?? "{}"));
			} catch {
				leaf(fn, "arguments");
				continue;
			}
			const box = { args };
			leaf(box, "args");
			slots.push({ get: () => "", set: () => (fn.arguments = JSON.stringify(box.args)) });
		}
	}
	// The arguments as finally sent, keys included, are verified too.
	return { slots, fixed, args: () => fns.map((fn) => String(fn.arguments ?? "")) };
}

/**
 * A second, optional detector that runs after the pattern anonymizer on the
 * already-pseudonymized texts: a local classifier for what the patterns miss
 * (a lone first name, an accented name, an address with no house number). It
 * returns the raw values it found; each is replaced by a pseudonym in the same
 * map, so the reply is restored like any other. A throw or a rejection fails
 * closed: nothing is sent. A timeout is the detector's to enforce, as a
 * rejection. None is set by default; this is the one place one plugs in (#274).
 */
export type PiiSecondDetector = (texts: string[]) => Promise<string[]>;
let secondDetector: PiiSecondDetector | null = null;
export function setPiiSecondDetector(d: PiiSecondDetector | null): void {
	secondDetector = d;
}

/** Anonymize and verify a request body. Throws when it cannot be proven clean. */
export async function gateBody(raw: string): Promise<{ body: string; map: Map<string, string> }> {
	const body = JSON.parse(raw) as { messages?: unknown };
	const { slots, fixed, args } = slotsOf(body);
	const gated = anonymizer.anonymizeMessages(slots.map((s) => ({ role: "x", content: s.get() })));
	let texts = gated.messages.map((m) => m.content);
	if (secondDetector) {
		const found = [...new Set(await secondDetector(texts))].filter((v) => v.trim().length >= 2);
		found.sort((x, y) => y.length - x.length);
		for (const [i, raw] of found.entries()) {
			const token = `[PII_${i + 1}]`;
			gated.map.set(token, raw);
			texts = texts.map((t) => t.split(raw).join(token));
		}
	}
	slots.forEach((s, i) => s.set(texts[i]));
	const outbound = [...texts, ...fixed, ...args()].join("\n");
	if (!anonymizer.verifyClean(outbound)) throw new Error("PII survived anonymization");
	return { body: JSON.stringify(body), map: gated.map };
}

/** Restore pseudonyms in a non-streamed chat completion. */
function restoreJson(text: string, map: Map<string, string>): string {
	const json = JSON.parse(text) as { choices?: Record<string, unknown>[] };
	for (const c of json.choices ?? []) {
		const msg = c.message as Record<string, unknown> | undefined;
		if (!msg) continue;
		for (const k of ["content", "reasoning_content"]) {
			if (typeof msg[k] === "string") msg[k] = anonymizer.deanonymize(msg[k] as string, map);
		}
		for (const tc of (msg.tool_calls as Record<string, unknown>[] | undefined) ?? []) {
			const fn = tc.function as Record<string, unknown> | undefined;
			if (fn && typeof fn.arguments === "string")
				fn.arguments = anonymizer.deanonymize(fn.arguments, map);
		}
	}
	return JSON.stringify(json);
}

/** Restore pseudonyms across an SSE stream; a pseudonym split over chunks is held, not leaked half-restored. */
function restoreStream(
	src: ReadableStream<Uint8Array>,
	map: Map<string, string>,
): ReadableStream<Uint8Array> {
	const restorers = new Map<string, ReturnType<typeof anonymizer.createStreamDeanonymizer>>();
	const r = (key: string) => {
		let x = restorers.get(key);
		if (!x) restorers.set(key, (x = anonymizer.createStreamDeanonymizer(map)));
		return x;
	};
	const dec = new TextDecoder();
	const enc = new TextEncoder();
	let buf = "";
	const line = (l: string): string => {
		if (!l.startsWith("data:") || l.slice(5).trim() === "[DONE]") return l;
		let ev: { choices?: Record<string, unknown>[] };
		try {
			ev = JSON.parse(l.slice(5));
		} catch {
			return l;
		}
		for (const c of ev.choices ?? []) {
			const d = c.delta as Record<string, unknown> | undefined;
			const end = c.finish_reason != null;
			if (!d) continue;
			const fix = (key: string, holder: Record<string, unknown>, field: string) => {
				const s = r(key);
				const v = typeof holder[field] === "string" ? s.push(holder[field] as string) : "";
				const out = end ? v + s.flush() : v;
				if (typeof holder[field] === "string" || out) holder[field] = out;
			};
			fix(`${c.index}:content`, d, "content");
			fix(`${c.index}:reasoning`, d, "reasoning_content");
			for (const tc of (d.tool_calls as Record<string, unknown>[] | undefined) ?? []) {
				const fn = tc.function as Record<string, unknown> | undefined;
				if (fn) fix(`${c.index}:tool:${tc.index}`, fn, "arguments");
			}
		}
		return `data: ${JSON.stringify(ev)}`;
	};
	return src.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, ctl) {
				buf += dec.decode(chunk, { stream: true });
				const lines = buf.split("\n");
				buf = lines.pop() ?? "";
				if (lines.length) ctl.enqueue(enc.encode(`${lines.map(line).join("\n")}\n`));
			},
			flush(ctl) {
				if (buf) ctl.enqueue(enc.encode(line(buf)));
			},
		}),
	);
}

/**
 * Wrap a fetch bound for a cloud endpoint. A request with a body is gated
 * (anonymized and verified, or refused); its reply is restored. A body-less
 * request (a model list) carries no conversation and passes through.
 */
export function piiGatedFetch(base: typeof fetch): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		if (init?.body == null) return base(input, init);
		let gated: { body: string; map: Map<string, string> };
		try {
			if (typeof init.body !== "string") throw new Error("body is not text");
			gated = await gateBody(init.body);
		} catch {
			throw new Error(FAIL);
		}
		const res = await base(input, { ...init, body: gated.body });
		if (gated.map.size === 0 || !res.body) return res;
		const type = res.headers.get("content-type") ?? "";
		if (type.includes("text/event-stream")) {
			return new Response(restoreStream(res.body, gated.map), res);
		}
		if (!type.includes("json")) return res;
		const text = await res.text();
		let out = text;
		try {
			out = restoreJson(text, gated.map);
		} catch {
			// Not a chat completion (an error body): hand it back as it came.
		}
		const headers = new Headers(res.headers);
		headers.delete("content-length");
		return new Response(out, { status: res.status, statusText: res.statusText, headers });
	}) as unknown as typeof fetch;
}
