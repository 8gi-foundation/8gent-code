#!/usr/bin/env bun
/**
 * LetsFG flight search extension: a stdio JSON-RPC (MCP) server, one process, no dependencies.
 *
 * Read-only. It searches and reads results and booking status. It has no
 * booking call: spending money needs the host's approval channel, which is a
 * separate piece of work.
 *
 * The token is read at call time from LETSFG_BEARER_TOKEN or the system
 * keychain (service "8gent-letsfg"). It is never written, logged or returned.
 * The host passes a child only PATH, HOME and locale variables, so on a host
 * run the keychain is the route; the env var serves a direct run.
 */

import { spawnSync } from "node:child_process";

export const DEFAULT_BASE = "https://letsfg.co/api";
const KEYCHAIN_SERVICE = "8gent-letsfg";

// C0, DEL, C1 controls, bidi marks, overrides and isolates, line and paragraph
// separators, and zero-width characters: vendor text must not rewrite or hide
// anything in a terminal line.
// A string, not a literal: the formatter rewrites escapes in a literal into the raw characters.
// biome-ignore lint/complexity/useRegexLiterals: see above
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
const clean = (v: unknown): string =>
	String(v ?? "")
		.replace(UNSAFE, " ")
		.slice(0, 200);

export interface Deps {
	fetch: typeof fetch;
	baseUrl: string;
	token: () => string | null;
	sleep: (ms: number) => Promise<void>;
	/** Bounded wait for results to finish. */
	pollMs: number;
	pollEveryMs: number;
}

export function keychainToken(): string | null {
	const env = process.env.LETSFG_BEARER_TOKEN?.trim();
	if (env) return env;
	// Absolute paths: PATH is never searched for a program that hands back a secret.
	const [cmd, args] =
		process.platform === "darwin"
			? ["/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]]
			: ["/usr/bin/secret-tool", ["lookup", "service", KEYCHAIN_SERVICE]];
	try {
		const r = spawnSync(cmd as string, args as string[], { encoding: "utf-8", timeout: 5000 });
		if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
	} catch {}
	return null;
}

/** The service address: https only, so the token never travels in clear. */
export function baseFromEnv(env: Record<string, string | undefined> = process.env): string {
	const raw = (env.LETSFG_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("LETSFG_BASE_URL is not a valid address.");
	}
	if (url.protocol !== "https:") throw new Error("LETSFG_BASE_URL must start with https://.");
	return raw;
}

const defaults = (): Deps => ({
	fetch,
	baseUrl: baseFromEnv(),
	token: keychainToken,
	sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
	pollMs: 20_000,
	pollEveryMs: 2_000,
});

type Args = Record<string, unknown>;
interface Offer {
	id?: string;
	price?: number;
	currency?: string;
	airline?: string;
	airlines?: string[];
	route?: string;
	departure_time?: string;
	duration_minutes?: number;
	duration_seconds?: number;
	stops?: number;
	stopovers?: number;
}

class ToolError extends Error {}

const TOOLS = [
	{
		name: "search_flights",
		description:
			"Search flights. Read-only: nothing is held or bought. Give IATA origin and destination and date_from (YYYY-MM-DD); return_date makes it a round trip.",
		inputSchema: {
			type: "object",
			properties: {
				origin: { type: "string" },
				destination: { type: "string" },
				date_from: { type: "string" },
				return_date: { type: "string" },
				adults: { type: "number" },
				cabin: { type: "string", description: "M economy, W premium, C business, F first" },
				max_stops: { type: "number" },
				currency: { type: "string" },
			},
			required: ["origin", "destination", "date_from"],
		},
	},
	{
		name: "get_flight_results",
		description: "Fetch the current offers of an earlier search by search_id. Read-only.",
		inputSchema: {
			type: "object",
			properties: { search_id: { type: "string" } },
			required: ["search_id"],
		},
	},
	{
		name: "get_flight_booking",
		description: "Check the status of a booking made elsewhere, by booking_ref. Read-only.",
		inputSchema: {
			type: "object",
			properties: { booking_ref: { type: "string" } },
			required: ["booking_ref"],
		},
	},
];

const str = (a: Args, k: string, re?: RegExp): string => {
	const v = a[k];
	if (typeof v !== "string" || !v.trim() || (re && !re.test(v.trim())))
		throw new ToolError(`${k} is missing or not valid.`);
	return v.trim();
};
const has = (a: Args, k: string, type: "string" | "number"): boolean =>
	type === "string" ? typeof a[k] === "string" : typeof a[k] === "number";

const IATA = /^[A-Za-z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

async function call(d: Deps, method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
	const token = d.token();
	if (!token)
		throw new ToolError(
			`No LetsFG token. Store one in the keychain under service "${KEYCHAIN_SERVICE}" (macOS: security add-generic-password -s ${KEYCHAIN_SERVICE} -a $USER -w), or set LETSFG_BEARER_TOKEN for a direct run. Get a token by approving a connection at letsfg.co.`,
		);
	const res = await d.fetch(`${d.baseUrl}${path}`, {
		method,
		headers: {
			accept: "application/json",
			authorization: `Bearer ${token}`,
			...(body ? { "content-type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) throw new ToolError(`LetsFG answered ${res.status}: ${clean(await res.text())}`);
	return res.json();
}

const durationOf = (o: Offer): string =>
	o.duration_minutes != null
		? `${o.duration_minutes} min`
		: o.duration_seconds != null
			? `${Math.round(o.duration_seconds / 60)} min`
			: "unknown duration";

function describe(o: Offer): string {
	const who = o.airline ?? o.airlines?.join(", ") ?? "unknown airline";
	const stops = o.stops ?? o.stopovers;
	return [
		clean(who),
		o.route ? clean(o.route) : null,
		o.departure_time ? `departs ${clean(o.departure_time)}` : null,
		durationOf(o),
		stops != null ? `${Number(stops) || 0} stop(s)` : null,
	]
		.filter(Boolean)
		.join(", ");
}

async function results(d: Deps, searchId: string): Promise<any> {
	const end = Date.now() + d.pollMs;
	for (;;) {
		const r = await call(d, "GET", `/results/${encodeURIComponent(searchId)}`);
		if (r?.status !== "searching" || Date.now() >= end) return r;
		await d.sleep(d.pollEveryMs);
	}
}

const render = (searchId: string, r: any) =>
	JSON.stringify({
		search_id: searchId,
		status: clean(r?.status),
		total_results: r?.total_results,
		offers: ((r?.offers ?? []) as Offer[]).slice(0, 10).map((o) => ({
			offer_id: clean(o.id),
			price: o.price,
			currency: clean(o.currency),
			summary: describe(o),
		})),
		note: "Search only. Nothing is held or bought.",
	});

async function run(d: Deps, name: string, a: Args): Promise<string> {
	switch (name) {
		case "search_flights": {
			const body: Record<string, unknown> = {
				origin: str(a, "origin", IATA).toUpperCase(),
				destination: str(a, "destination", IATA).toUpperCase(),
				date_from: str(a, "date_from", DATE),
			};
			if (a.return_date !== undefined) body.return_date = str(a, "return_date", DATE);
			for (const k of ["adults", "max_stops"]) if (has(a, k, "number")) body[k] = a[k];
			for (const k of ["cabin", "currency"]) if (has(a, k, "string")) body[k] = a[k];
			const s = await call(d, "POST", "/search", body);
			if (!s?.search_id) throw new ToolError("LetsFG returned no search id.");
			return render(String(s.search_id), await results(d, String(s.search_id)));
		}
		case "get_flight_results": {
			const id = str(a, "search_id", ID);
			return render(id, await results(d, id));
		}
		case "get_flight_booking": {
			const ref = str(a, "booking_ref", ID);
			const b = await call(d, "POST", "/agent-book/status", { booking_ref: ref });
			return JSON.stringify({
				state: clean(b?.state),
				pnr: clean(b?.pnr),
				charged_amount: b?.charged_amount,
			});
		}
		default:
			throw new ToolError(`Unknown tool ${clean(name)}.`);
	}
}

/** One JSON-RPC message in, the reply out (null for a notification). */
export async function handle(d: Deps, msg: any): Promise<unknown | null> {
	if (!msg || msg.id === undefined) return null;
	const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
	switch (msg.method) {
		case "initialize":
			return ok({
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "letsfg", version: "0.2.0" },
			});
		case "tools/list":
			return ok({ tools: TOOLS });
		case "tools/call": {
			try {
				const text = await run(d, msg.params?.name, msg.params?.arguments ?? {});
				return ok({ content: [{ type: "text", text }] });
			} catch (e) {
				const text = e instanceof ToolError ? e.message : "LetsFG could not be reached.";
				return ok({ isError: true, content: [{ type: "text", text }] });
			}
		}
		default:
			return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } };
	}
}

/**
 * Read newline-delimited messages and answer them strictly in order. A chain of
 * promises is the only place a message is handled, so two handlers never run at
 * once; the buffer is only touched synchronously inside the data event, never
 * across an await.
 */
export function serve(
	d: Deps,
	input: NodeJS.ReadableStream,
	write: (line: string) => void,
): Promise<void> {
	let buf = "";
	let chain: Promise<void> = Promise.resolve();
	input.setEncoding?.("utf-8");
	input.on("data", (chunk: string | Buffer) => {
		buf += chunk;
		const lines = buf.split("\n");
		buf = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			chain = chain.then(async () => {
				let msg: unknown;
				try {
					msg = JSON.parse(line);
				} catch {
					return;
				}
				const reply = await handle(d, msg);
				if (reply) write(`${JSON.stringify(reply)}\n`);
			});
		}
	});
	return new Promise((resolve) => input.on("end", () => chain.then(resolve)));
}

if (import.meta.main) {
	await serve(defaults(), process.stdin, (l) => process.stdout.write(l));
}
