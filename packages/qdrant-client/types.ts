// Types for @8gent/qdrant-client. See README for scope.

export interface QdrantClientOptions {
	/** Host. Default is loopback for on-device memory. */
	host?: string;
	/** Qdrant REST port. Default 6333. */
	port?: number;
	/** Optional API key. Not required for 127.0.0.1 binding. */
	apiKey?: string;
	/** Request timeout in milliseconds. */
	timeoutMs?: number;
}

export interface QdrantPoint {
	id: string | number;
	vector: number[];
	payload?: Record<string, unknown>;
}

export interface QdrantSearchHit {
	id: string | number;
	score: number;
	payload?: Record<string, unknown>;
}

export interface QdrantClient {
	upsert(collection: string, points: QdrantPoint[]): Promise<void>;
	search(
		collection: string,
		vector: number[],
		topK: number,
	): Promise<QdrantSearchHit[]>;
	deleteCollection(name: string): Promise<void>;
	healthCheck(): Promise<{ ok: boolean; version?: string }>;
}
