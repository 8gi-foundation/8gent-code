/**
 * Flow brain sync client — the network half of issue #2754 step 3 (two-way sync
 * with Flow's /brain API). Wave-1 shipped the pure serialization layer
 * (flow-sync.ts); this is the client loop that actually walks a kernel project
 * subgraph and POSTs it to the relay so a lesson learned in the TUI surfaces in
 * Flow's brain pane.
 *
 *   entity -> POST {baseUrl}/brain/entity  { id, label, kind, detail, dimension, source, props }
 *   edge   -> POST {baseUrl}/brain/edge     { src, dst, type }
 *
 * Design invariants:
 *
 *   1. Local-first, fail-closed. The brain is on-device (~/.8gent/brain.db, a
 *      localhost relay). The client REFUSES a non-loopback base URL unless
 *      `allowRemote` is explicitly set, so owned memory (which can contain PII)
 *      never egresses to a cloud host by accident. A misconfigured host throws
 *      loudly before any request is sent — it is not a silent no-op.
 *
 *   2. Idempotent by construction. Deterministic entity ids (flow-sync.ts) mean a
 *      re-POST updates the brain row in place. An optional `knownHashes` cache
 *      (id -> content hash) lets the client SKIP an entity whose content is
 *      unchanged since the last sync, so a steady-state re-sync makes zero writes.
 *      The cache is updated in place as entities sync, so the caller can persist
 *      it and feed it to the next run.
 *
 *   3. Fail-soft per item, connected on success. A single failed entity/edge POST
 *      is recorded and the loop continues; it never aborts the whole sync. An edge
 *      is only sent when BOTH endpoints are present in the brain this run (freshly
 *      synced or skipped-because-unchanged), so a failed entity never leaves a
 *      dangling edge pointing at nothing.
 *
 * This module performs no deletes and never overwrites via last-writer-wins on the
 * client side; the relay's add_entity is insert-or-update by deterministic id and
 * Flow's provenance ledger keeps every prior value (Solomon's hard rule).
 */

import {
	type BrainEdgePayload,
	type BrainEntityPayload,
	type BrainSyncBundle,
	entityContentHash,
	toBrainSyncBundle,
} from "./flow-sync.js";
import type { KnowledgeGraph, PatternQuery, SubgraphResult } from "./graph.js";

/** Minimal fetch surface so the client is testable without the network. Compatible with global `fetch`. */
export type FetchLike = (
	url: string,
	init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number }>;

export interface FlowSyncClientOptions {
	/** Relay base URL. Defaults to the on-device relay. */
	baseUrl?: string;
	/** Injected fetch (defaults to global fetch). */
	fetch?: FetchLike;
	/**
	 * Allow a non-loopback base URL. Off by default so owned memory never leaves
	 * the device by accident. Set true ONLY for a trusted same-tailnet relay.
	 */
	allowRemote?: boolean;
	/**
	 * id -> content-hash cache from a previous run. An entity whose current hash
	 * matches is skipped (no write). Mutated in place as entities sync so it can be
	 * persisted and reused next run.
	 */
	knownHashes?: Map<string, string>;
}

export type SyncFailureKind = "entity" | "edge";

export interface SyncFailure {
	kind: SyncFailureKind;
	/** entity id, or "src->dst" for an edge. */
	id: string;
	error: string;
}

export interface SyncReport {
	entitiesSynced: number;
	entitiesSkipped: number;
	entitiesFailed: number;
	edgesSynced: number;
	edgesFailed: number;
	/** Edges dropped by the serializer (endpoint outside the mapped entity set). */
	droppedEdges: number;
	failures: SyncFailure[];
}

const DEFAULT_BASE_URL = "http://127.0.0.1:7890";

/**
 * True if `url`'s host is a loopback address (localhost / 127.0.0.0-8 / ::1). A
 * non-loopback host is treated as potential cloud egress and blocked unless the
 * caller opts in via `allowRemote`.
 */
export function isLoopbackUrl(url: string): boolean {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	// URL() keeps IPv6 hosts in brackets; strip them for comparison.
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
	if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
	// 127.0.0.0/8
	const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (m && Number(m[1]) === 127) return true;
	return false;
}

/**
 * Network client that pushes a kernel subgraph into Flow's owned brain graph.
 * Construct once and reuse; pass a shared `knownHashes` map to keep re-syncs cheap.
 */
export class FlowBrainSyncClient {
	private readonly baseUrl: string;
	private readonly fetch: FetchLike;
	private readonly allowRemote: boolean;
	private readonly knownHashes?: Map<string, string>;

	constructor(opts: FlowSyncClientOptions = {}) {
		this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
		this.fetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
		this.allowRemote = opts.allowRemote ?? false;
		this.knownHashes = opts.knownHashes;
		if (!this.allowRemote && !isLoopbackUrl(this.baseUrl)) {
			throw new Error(
				`FlowBrainSyncClient: refusing non-loopback relay ${this.baseUrl}. Owned memory is local-first; pass allowRemote:true for a trusted same-tailnet relay.`,
			);
		}
	}

	/** POST one entity to /brain/entity. Returns a per-item result; never throws. */
	private async postEntity(entity: BrainEntityPayload): Promise<{ ok: boolean; error?: string }> {
		try {
			const res = await this.fetch(`${this.baseUrl}/brain/entity`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(entity),
			});
			if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/** POST one edge to /brain/edge. Returns a per-item result; never throws. */
	private async postEdge(edge: BrainEdgePayload): Promise<{ ok: boolean; error?: string }> {
		try {
			const res = await this.fetch(`${this.baseUrl}/brain/edge`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(edge),
			});
			if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/**
	 * Push a ready-made bundle. Entities first (so edges can reference them), then
	 * edges between endpoints that are actually present in the brain this run.
	 */
	async syncBundle(bundle: BrainSyncBundle): Promise<SyncReport> {
		const report: SyncReport = {
			entitiesSynced: 0,
			entitiesSkipped: 0,
			entitiesFailed: 0,
			edgesSynced: 0,
			edgesFailed: 0,
			droppedEdges: bundle.droppedEdges,
			failures: [],
		};

		// Entity ids present in the brain after this run (synced or unchanged-skip).
		// An edge is only safe to send when both endpoints are in this set.
		const present = new Set<string>();

		for (const entity of bundle.entities) {
			const hash = entityContentHash(entity);
			if (this.knownHashes && this.knownHashes.get(entity.id) === hash) {
				report.entitiesSkipped++;
				present.add(entity.id);
				continue;
			}
			const res = await this.postEntity(entity);
			if (res.ok) {
				report.entitiesSynced++;
				present.add(entity.id);
				this.knownHashes?.set(entity.id, hash);
			} else {
				report.entitiesFailed++;
				report.failures.push({ kind: "entity", id: entity.id, error: res.error ?? "unknown" });
			}
		}

		for (const edge of bundle.edges) {
			if (!present.has(edge.src) || !present.has(edge.dst)) {
				// An endpoint failed to sync this run; sending the edge would dangle.
				report.edgesFailed++;
				report.failures.push({
					kind: "edge",
					id: `${edge.src}->${edge.dst}`,
					error: "endpoint not present in brain (entity sync failed)",
				});
				continue;
			}
			const res = await this.postEdge(edge);
			if (res.ok) {
				report.edgesSynced++;
			} else {
				report.edgesFailed++;
				report.failures.push({
					kind: "edge",
					id: `${edge.src}->${edge.dst}`,
					error: res.error ?? "unknown",
				});
			}
		}

		return report;
	}

	/** Serialize a kernel subgraph (flow-sync.ts) then push it. */
	async syncSubgraph(subgraph: SubgraphResult): Promise<SyncReport> {
		return this.syncBundle(toBrainSyncBundle(subgraph));
	}

	/**
	 * Walk one project's subgraph from the kernel KnowledgeGraph and push it. This
	 * is the entry point a scheduled sync calls: "put this project's owned memory
	 * into Flow's brain". `limit` bounds a single run so a huge graph syncs in pages.
	 */
	async syncProject(
		graph: KnowledgeGraph,
		projectId: string,
		opts: { limit?: number } = {},
	): Promise<SyncReport> {
		const pattern: PatternQuery = { limit: opts.limit ?? 500 };
		const subgraph = graph.query(pattern, projectId);
		return this.syncSubgraph(subgraph);
	}
}
