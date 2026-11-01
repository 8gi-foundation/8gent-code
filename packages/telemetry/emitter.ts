/**
 * Telemetry emitter.
 *
 * Default sink writes one JSON object per line to stdout. Vector picks
 * these up via its `stdin` source (or `file` source when the daemon is
 * containerised) and ships them to Loki.
 *
 * Tests and library callers can swap in a memory sink via `setSink()`.
 */

import type { TelemetryEvent } from "./events";

export interface TelemetrySink {
	write(event: TelemetryEvent): void;
}

class StdoutSink implements TelemetrySink {
	write(event: TelemetryEvent): void {
		// One JSON object per line. No trailing whitespace beyond \n so
		// Vector's `parse_json` transform stays happy.
		process.stdout.write(`${JSON.stringify(event)}\n`);
	}
}

export class MemorySink implements TelemetrySink {
	public events: TelemetryEvent[] = [];
	write(event: TelemetryEvent): void {
		this.events.push(event);
	}
	clear(): void {
		this.events = [];
	}
}

let activeSink: TelemetrySink = new StdoutSink();

export function setSink(sink: TelemetrySink): void {
	activeSink = sink;
}

export function getSink(): TelemetrySink {
	return activeSink;
}

export function resetSinkToStdout(): void {
	activeSink = new StdoutSink();
}
