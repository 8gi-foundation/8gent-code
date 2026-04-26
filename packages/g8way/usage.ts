/**
 * @8gent/g8way - Usage logger.
 *
 * One JSON line per request to stdout, picked up by Vector and shipped
 * to Loki (per Phase 1 observability). Keep this file dumb on purpose:
 * no buffering, no batching, no DB writes. The observability stack owns
 * persistence; the proxy just emits structured events.
 */

import type { UsageRecord } from "./types";

export interface UsageLogger {
	log(record: UsageRecord): void;
}

class StdoutUsageLogger implements UsageLogger {
	log(record: UsageRecord): void {
		process.stdout.write(`${JSON.stringify(record)}\n`);
	}
}

export function createStdoutLogger(): UsageLogger {
	return new StdoutUsageLogger();
}

export class InMemoryUsageLogger implements UsageLogger {
	records: UsageRecord[] = [];
	log(record: UsageRecord): void {
		this.records.push(record);
	}
}
