/**
 * OpenTelemetry-compatible identifiers.
 *
 * We don't import the OTel SDK to keep this package zero-dep. Instead we
 * generate W3C trace context ids by hand (random hex). When a real OTel
 * collector is plugged in later, these ids can be lifted into spans
 * without translation.
 *
 * Reference: https://www.w3.org/TR/trace-context/
 */

const HEX = "0123456789abcdef";

function randomHex(bytes: number): string {
	const arr = new Uint8Array(bytes);
	crypto.getRandomValues(arr);
	let out = "";
	for (let i = 0; i < bytes; i++) {
		const b = arr[i];
		out += HEX[(b >> 4) & 0xf] + HEX[b & 0xf];
	}
	return out;
}

/** 32 hex chars = 16 random bytes. */
export function newTraceId(): string {
	return randomHex(16);
}

/** 16 hex chars = 8 random bytes. */
export function newSpanId(): string {
	return randomHex(8);
}

/** Unix nanoseconds. Bun supports Bun.nanoseconds; fall back to ms*1e6. */
export function nowUnixNano(): number {
	const bunGlobal = (globalThis as unknown as { Bun?: { nanoseconds?: () => bigint } }).Bun;
	if (bunGlobal?.nanoseconds) {
		try {
			return Number(bunGlobal.nanoseconds());
		} catch {
			// fall through
		}
	}
	return Date.now() * 1_000_000;
}

/**
 * SpanContext is the minimal handle a caller threads through nested
 * operations so child events get the right `traceId` + `parentSpanId`.
 */
export interface SpanContext {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	startTimeUnixNano: number;
}

export function newSpanContext(parent?: SpanContext): SpanContext {
	return {
		traceId: parent?.traceId ?? newTraceId(),
		spanId: newSpanId(),
		parentSpanId: parent?.spanId,
		startTimeUnixNano: nowUnixNano(),
	};
}

/** Validate a trace id is the expected 32-hex format. */
export function isValidTraceId(id: string): boolean {
	return /^[0-9a-f]{32}$/.test(id);
}

/** Validate a span id is the expected 16-hex format. */
export function isValidSpanId(id: string): boolean {
	return /^[0-9a-f]{16}$/.test(id);
}
