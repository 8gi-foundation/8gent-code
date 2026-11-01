/**
 * One line of daemon.log for a bus event. Binary and audio payloads never go in the log: any value under `audio`, `data`,
 * `bytes` or `base64` that is binary, or a string long enough to be an encoding of binary, is replaced by { type, size }.
 * That covers the day8 `/dj play` turn, whose agent:stream payload carries up to ~4 MB of base64 audio (#5245). A line is also
 * capped, so no future field can write a megabyte. Fixes the class (any event, any depth), not the one field.
 */
export const LOG_LINE_MAX = 8_000;
const BINARY_KEYS = new Set(["audio", "data", "bytes", "base64"]);
const LONG_STRING = 256;
const MAX_DEPTH = 6;

function sizeOf(v: unknown): number {
	if (typeof v === "string") return v.length;
	if (v instanceof ArrayBuffer) return v.byteLength;
	if (ArrayBuffer.isView(v)) return v.byteLength;
	if (v && typeof v === "object") {
		let n = 0;
		for (const k of BINARY_KEYS) {
			const x = (v as Record<string, unknown>)[k];
			if (typeof x === "string" || x instanceof ArrayBuffer || ArrayBuffer.isView(x))
				n += sizeOf(x);
		}
		return n;
	}
	return 0;
}

function typeOf(v: unknown): string {
	if (v && typeof v === "object" && typeof (v as { mime?: unknown }).mime === "string")
		return String((v as { mime: string }).mime).slice(0, 60);
	if (typeof v === "string") return "string";
	if (v instanceof ArrayBuffer) return "ArrayBuffer";
	if (ArrayBuffer.isView(v)) return v.constructor.name;
	return "object";
}

/** True for a value that must not be logged under a binary key. */
function isBinary(v: unknown): boolean {
	if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return true;
	if (typeof v === "string") return v.length > LONG_STRING;
	// an audio envelope: { mime, base64 } or anything holding a binary or long string field under a binary key
	return !!v && typeof v === "object" && sizeOf(v) > LONG_STRING;
}

export function redact(value: unknown, depth = 0): unknown {
	if (depth > MAX_DEPTH) return "[deep]";
	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value))
		return { type: typeOf(value), size: sizeOf(value) };
	if (Array.isArray(value)) return value.map((x) => redact(x, depth + 1));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] =
				BINARY_KEYS.has(k) && isBinary(v)
					? { type: typeOf(v), size: sizeOf(v) }
					: redact(v, depth + 1);
		}
		return out;
	}
	return value;
}

export function logLine(event: string, payload: unknown, now: Date = new Date()): string {
	let body: string;
	try {
		body = JSON.stringify(redact(payload)) ?? "";
	} catch {
		body = '"[unserialisable]"';
	}
	if (body.length > LOG_LINE_MAX)
		body = `${body.slice(0, LOG_LINE_MAX)}...[truncated ${body.length - LOG_LINE_MAX} chars]`;
	return `${now.toISOString()} [${event}] ${body}\n`;
}
