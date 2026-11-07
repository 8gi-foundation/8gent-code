#!/usr/bin/env bun
/**
 * LetsFG travel extension: a stdio JSON-RPC (MCP) server, one process, no dependencies.
 *
 * Search is read-only. book_flight is the only call that spends money, and it
 * never trusts the caller: it re-reads the offer from LetsFG, shows the person
 * the item and the price on their own terminal, and starts the booking only on
 * a typed yes. No terminal, CI, a headless run, a timeout or a bare Enter is No.
 * Nothing is remembered between bookings.
 *
 * The token is read at call time from LETSFG_BEARER_TOKEN or the system
 * keychain (service "8gent-letsfg"). It is never written, logged or returned.
 * The host passes a child only PATH, HOME and locale variables, so on a host
 * run the keychain is the route; the env var serves a direct run.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as tty from "node:tty";

export const DEFAULT_BASE = "https://letsfg.co/api";
const KEYCHAIN_SERVICE = "8gent-letsfg";
const ASK_TIMEOUT_MS = 60_000;

// C0, DEL, C1 controls and bidi overrides: vendor text must not rewrite a terminal line.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
const clean = (v: unknown): string =>
	String(v ?? "")
		.replace(UNSAFE, " ")
		.slice(0, 200);

export interface Deps {
	fetch: typeof fetch;
	baseUrl: string;
	token: () => string | null;
	/** Show the summary to the person; true only for a typed yes. */
	ask: (summary: string) => Promise<boolean>;
	sleep: (ms: number) => Promise<void>;
	/** Bounded wait for results to finish. */
	pollMs: number;
	pollEveryMs: number;
}

export function keychainToken(): string | null {
	const env = process.env.LETSFG_BEARER_TOKEN?.trim();
	if (env) return env;
	const [cmd, args] =
		process.platform === "darwin"
			? ["security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]]
			: ["secret-tool", ["lookup", "service", KEYCHAIN_SERVICE]];
	try {
		const r = spawnSync(cmd as string, args as string[], { encoding: "utf-8", timeout: 5000 });
		if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
	} catch {}
	return null;
}

/** Ask on the person's own terminal. Anything but a typed y or yes inside the wait is No. */
export async function askOnTerminal(summary: string): Promise<boolean> {
	const e = process.env;
	if (e.CI || e.EIGHT_UNATTENDED || e.EIGHT_HEADLESS) return false;
	let fd: number;
	try {
		fd = fs.openSync("/dev/tty", "r+");
	} catch {
		return false;
	}
	const input = new tty.ReadStream(fd);
	try {
		fs.writeSync(fd, `\n${summary}\nBook this? [y/N] `);
		const line = await new Promise<string>((resolve) => {
			const timer = setTimeout(() => resolve(""), ASK_TIMEOUT_MS);
			input.once("data", (d) => {
				clearTimeout(timer);
				resolve(String(d));
			});
			input.once("error", () => {
				clearTimeout(timer);
				resolve("");
			});
			input.once("end", () => {
				clearTimeout(timer);
				resolve("");
			});
		});
		return /^y(es)?$/i.test(line.trim());
	} finally {
		input.destroy();
	}
}

const defaults = (): Deps => ({
	fetch,
	baseUrl: (process.env.LETSFG_BASE_URL || DEFAULT_BASE).replace(/\/+$/, ""),
	token: keychainToken,
	ask: askOnTerminal,
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
		description: "Check the status of a booking by booking_ref. Read-only.",
		inputSchema: {
			type: "object",
			properties: { booking_ref: { type: "string" } },
			required: ["booking_ref"],
		},
	},
	{
		name: "book_flight",
		description:
			"Start a booking for one offer. The person is shown the item and the price and must type yes on their own terminal; without that nothing is sent. The card is held for the price and charged only after the airline confirms.",
		inputSchema: {
			type: "object",
			properties: {
				search_id: { type: "string" },
				offer_id: { type: "string" },
				contact_email: { type: "string" },
				passenger: { type: "object", description: "given_name, family_name, born_on, and so on" },
				additional_passengers: { type: "array", items: { type: "object" } },
			},
			required: ["search_id", "offer_id", "contact_email", "passenger"],
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
		status: r?.status,
		total_results: r?.total_results,
		offers: ((r?.offers ?? []) as Offer[]).slice(0, 10).map((o) => ({
			offer_id: o.id,
			price: o.price,
			currency: o.currency,
			summary: describe(o),
		})),
		note: "Search only. Nothing is held or bought. Use book_flight to start a booking; the person is asked first.",
	});

/** One booking per offer per session: a second would place a second hold. */
const started = new Set<string>();

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
			return render(s.search_id, await results(d, String(s.search_id)));
		}
		case "get_flight_results": {
			const id = str(a, "search_id", ID);
			return render(id, await results(d, id));
		}
		case "get_flight_booking": {
			const ref = str(a, "booking_ref", ID);
			return JSON.stringify(await call(d, "POST", "/agent-book/status", { booking_ref: ref }));
		}
		case "book_flight": {
			const searchId = str(a, "search_id", ID);
			const offerId = str(a, "offer_id", ID);
			const email = str(a, "contact_email", /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
			const p = a.passenger;
			if (!p || typeof p !== "object") throw new ToolError("passenger is missing.");
			const more = Array.isArray(a.additional_passengers) ? a.additional_passengers : [];
			const key = `${searchId}/${offerId}`;
			if (started.has(key))
				throw new ToolError(
					"A booking for this offer was already started. Check its status instead.",
				);
			// The price shown comes from LetsFG now, never from the caller.
			const r = await results(d, searchId);
			const offer = ((r?.offers ?? []) as Offer[]).find((o) => o.id === offerId);
			if (!offer) throw new ToolError("That offer is not in the search any more. Search again.");
			if (typeof offer.price !== "number" || !offer.currency)
				throw new ToolError("The offer has no clear price, so it cannot be booked.");
			const seats = 1 + more.length;
			const cur = clean(offer.currency);
			const total = (offer.price * seats).toFixed(2);
			const summary = [
				`Flight: ${describe(offer)}`,
				`Travellers: ${seats}`,
				`Price: ${offer.price} ${cur} each, ${total} ${cur} in total`,
				`Your card is held for ${total} ${cur} now and charged only when the airline confirms.`,
				`Contact: ${clean(email)}`,
			].join("\n");
			if (!(await d.ask(summary)))
				return "Not booked. The person did not say yes. Nothing was sent to LetsFG.";
			started.add(key);
			const b = await call(d, "POST", "/agent-book", {
				search_id: searchId,
				offer_id: offerId,
				contact_email: email,
				passenger: p,
				...(more.length ? { additional_passengers: more } : {}),
			});
			return JSON.stringify({
				...b,
				note: "Booking started. Poll get_flight_booking with booking_ref. It can take 4 to 11 minutes.",
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
				serverInfo: { name: "letsfg", version: "0.1.0" },
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

if (import.meta.main) {
	const d = defaults();
	let buf = "";
	process.stdin.setEncoding("utf-8");
	process.stdin.on("data", async (chunk) => {
		buf += chunk;
		let i = buf.indexOf("\n");
		while (i >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			i = buf.indexOf("\n");
			if (!line.trim()) continue;
			let msg: unknown;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			const reply = await handle(d, msg);
			if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
		}
	});
}
