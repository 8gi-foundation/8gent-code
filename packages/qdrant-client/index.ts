// @8gent/qdrant-client
//
// Thin typed seam around a local-only Qdrant instance. v0 ships stubs so other
// packages (notably @8gent/memory and the security threat model in #1748) can
// reference a stable surface while we decide on Qdrant bundling, Docker tax,
// and encryption-at-rest strategy.
//
// Every method currently throws NotImplemented. Do not ship this against a
// real store until #1748 lands.
//
// See: docs/prd/8gent-computer/architecture.md (PR #1747), parent PRD #1746.

import type {
	QdrantClient,
	QdrantClientOptions,
	QdrantPoint,
	QdrantSearchHit,
} from "./types";

const DEFAULTS: Required<Omit<QdrantClientOptions, "apiKey">> = {
	host: "127.0.0.1",
	port: 6333,
	timeoutMs: 5000,
};

class NotImplementedError extends Error {
	constructor(method: string) {
		super(
			`@8gent/qdrant-client: ${method} is not implemented yet. Scaffold only - see issue #1756 and security review #1748.`,
		);
		this.name = "NotImplementedError";
	}
}

export function createClient(opts: QdrantClientOptions = {}): QdrantClient {
	const cfg = { ...DEFAULTS, ...opts };
	// cfg is retained so later implementations can read host/port/apiKey/timeoutMs.
	void cfg;

	return {
		async upsert(_collection: string, _points: QdrantPoint[]): Promise<void> {
			throw new NotImplementedError("upsert");
		},
		async search(
			_collection: string,
			_vector: number[],
			_topK: number,
		): Promise<QdrantSearchHit[]> {
			throw new NotImplementedError("search");
		},
		async deleteCollection(_name: string): Promise<void> {
			throw new NotImplementedError("deleteCollection");
		},
		async healthCheck(): Promise<{ ok: boolean; version?: string }> {
			throw new NotImplementedError("healthCheck");
		},
	};
}

export type {
	QdrantClient,
	QdrantClientOptions,
	QdrantPoint,
	QdrantSearchHit,
} from "./types";
