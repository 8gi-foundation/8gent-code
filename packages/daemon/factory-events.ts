/**
 * factory/v1 event log (#5117). One JSON line per event, appended to the file
 * named by EIGHT_EVENTS_FILE. With the variable unset nothing is written.
 * Local file only: no network. Schema: docs/specs/factory-events.schema.json.
 */

import {
	constants,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { scrub } from "../eight/secret-scanner";
import { scrubGoalText } from "../permissions/goal-secret-scrub";

export const FACTORY_KINDS = [
	"item.picked",
	"item.done",
	"item.blocked",
	"pr.opened",
	"review.requested",
	"review.approved",
	"review.changes",
	"checks.running",
	"checks.green",
	"checks.red",
	"merge.done",
	"pr.closed",
	"cell.heartbeat",
	"cell.paused",
	"cell.resumed",
	"budget.hit",
	"gate.blocked",
] as const;
export const FACTORY_STATES = ["live", "working", "idle", "paused"] as const;

export type FactoryKind = (typeof FACTORY_KINDS)[number];
export type FactoryState = (typeof FACTORY_STATES)[number];

export interface FactoryEvent {
	v: "factory/v1";
	id: string;
	at: string;
	cell: string;
	kind: FactoryKind;
	repo: string;
	number: number;
	title: string;
	sha: string;
	state: FactoryState;
	detail: string;
}

export type FactoryInput = Pick<FactoryEvent, "kind" | "state"> &
	Partial<Omit<FactoryEvent, "v" | "id" | "at" | "kind" | "state">>;

export const MAX_BYTES = 10 * 1024 * 1024;
export const KEEP = 3;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now = Date.now()): string {
	let t = "";
	for (let i = 0, n = now; i < 10; i++, n = Math.floor(n / 32)) t = CROCKFORD[n % 32] + t;
	const r = crypto.getRandomValues(new Uint8Array(16));
	return t + Array.from(r, (b) => CROCKFORD[b % 32]).join("");
}

/**
 * Scrub one field with the shared scanners (Bearer, bot tokens, ghp_, sk-ant-, ...)
 * plus a dashed vendor-key pattern neither covers (sk-cp-...). Applied to every
 * string field written.
 */
export function scrubField(text: string): string {
	return scrub(scrubGoalText(text).clean).scrubbed.replace(
		/sk-[A-Za-z0-9_-]{20,}/g,
		"[REDACTED:vendor-key]",
	);
}

/** Scrub then cap at 140 chars. */
export function scrubDetail(detail: string): string {
	const clean = scrubField(detail);
	return clean.length > 140 ? clean.slice(0, 140) : clean;
}

/** Rotates only file, file.1..file.KEEP. rename and unlink act on links, never their targets. */
function rotate(file: string): void {
	try {
		if (lstatSync(file).size < MAX_BYTES) return;
	} catch {
		return;
	}
	if (existsSync(`${file}.${KEEP}`)) unlinkSync(`${file}.${KEEP}`);
	for (let i = KEEP - 1; i >= 1; i--)
		if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
	renameSync(file, `${file}.1`);
}

/** Append one event. Returns it, or null when EIGHT_EVENTS_FILE is unset or the write failed. */
export function emitFactory(
	input: FactoryInput,
	env: Record<string, string | undefined> = process.env,
): FactoryEvent | null {
	const file = env.EIGHT_EVENTS_FILE;
	if (!file) return null;
	const event: FactoryEvent = {
		v: "factory/v1",
		id: ulid(),
		at: new Date().toISOString(),
		cell: scrubField(input.cell ?? env.EIGHT_CELL ?? ""),
		kind: input.kind,
		repo: scrubField(input.repo ?? ""),
		number: input.number ?? 0,
		title: scrubField(input.title ?? ""),
		sha: scrubField(input.sha ?? ""),
		state: input.state,
		detail: scrubDetail(input.detail ?? ""),
	};
	try {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		rotate(file);
		// Owner-only, and never through a symlink at the log path.
		const fd = openSync(
			file,
			constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			writeSync(fd, `${JSON.stringify(event)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		return event;
	} catch (err) {
		console.error(`[factory-events] write failed: ${err instanceof Error ? err.message : err}`);
		return null;
	}
}

/** The typed emitter: factory.emit({ kind, state, ... }). */
export const factory = { emit: emitFactory };

interface JsonSchema {
	required?: string[];
	additionalProperties?: boolean;
	properties?: Record<
		string,
		{ type?: string; const?: unknown; enum?: unknown[]; pattern?: string; maxLength?: number }
	>;
}

/** Check one parsed line against docs/specs/factory-events.schema.json. Returns problems, empty when valid. */
export function validateFactoryEvent(value: unknown, schema: JsonSchema): string[] {
	const problems: string[] = [];
	const obj = value as Record<string, unknown>;
	if (!obj || typeof obj !== "object") return ["not an object"];
	for (const key of schema.required ?? []) if (!(key in obj)) problems.push(`missing ${key}`);
	for (const key of Object.keys(obj)) {
		const prop = schema.properties?.[key];
		if (!prop) {
			if (schema.additionalProperties === false) problems.push(`unknown ${key}`);
			continue;
		}
		const v = obj[key];
		const actual = Number.isInteger(v) ? "integer" : typeof v;
		if (prop.type && actual !== prop.type) problems.push(`${key} wrong type`);
		if (prop.const !== undefined && v !== prop.const) problems.push(`${key} not ${prop.const}`);
		if (prop.enum && !prop.enum.includes(v)) problems.push(`${key} not in enum`);
		if (prop.pattern && typeof v === "string" && !new RegExp(prop.pattern).test(v))
			problems.push(`${key} bad shape`);
		if (prop.maxLength !== undefined && typeof v === "string" && v.length > prop.maxLength)
			problems.push(`${key} too long`);
	}
	return problems;
}
