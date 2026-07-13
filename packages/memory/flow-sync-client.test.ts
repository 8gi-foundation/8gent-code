/**
 * Tests for the Flow brain sync client (flow-sync-client.ts) — the network loop
 * half of issue #2754 step 3.
 *
 * Covers:
 * 1. Loopback guard: non-loopback base URL is refused; allowRemote bypasses.
 * 2. isLoopbackUrl classification (localhost / 127.x / ::1 vs remote).
 * 3. syncBundle POSTs entities then edges to the right paths + payloads.
 * 4. knownHashes cache: unchanged entity is skipped (no write), edge still sent;
 *    cache is populated on a fresh sync so the next run skips.
 * 5. Fail-soft: a failed entity POST does not send its edges and never aborts the
 *    run; independent edges still sync.
 * 6. Edge POST failure is recorded.
 * 7. syncSubgraph end-to-end drops a dangling edge (droppedEdges) and syncs the rest.
 * 8. Network throw is caught per item (fail-soft), not propagated.
 */

import { describe, expect, it } from "bun:test";
import {
	type FetchLike,
	FlowBrainSyncClient,
	type SyncReport,
	isLoopbackUrl,
} from "./flow-sync-client.js";
import { toBrainEntity } from "./flow-sync.js";
import type { Entity, Relationship, SubgraphResult } from "./graph.js";

// ── Fixtures ──────────────────────────────────────────────────────────

function makeEntity(overrides: Partial<Entity> = {}): Entity {
	const now = 1_700_000_000_000;
	return {
		id: "ent_a",
		projectId: "8gent-code",
		type: "concept",
		name: "memory-v2",
		description: "hybrid recall",
		firstSeen: now,
		lastSeen: now,
		mentionCount: 3,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function makeRel(overrides: Partial<Relationship> = {}): Relationship {
	const now = 1_700_000_000_000;
	return {
		id: "rel_a",
		projectId: "8gent-code",
		sourceId: "ent_a",
		targetId: "ent_b",
		type: "relates_to",
		strength: 1,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

/** A recording fetch. `fail` marks paths that should return !ok; `throwOn` throws. */
function recordingFetch(opts: { fail?: Set<string>; throwOn?: Set<string> } = {}): {
	fetch: FetchLike;
	calls: { url: string; body: unknown }[];
} {
	const calls: { url: string; body: unknown }[] = [];
	const fetch: FetchLike = async (url, init) => {
		const body = init?.body ? JSON.parse(init.body) : undefined;
		calls.push({ url, body });
		if (opts.throwOn?.has(url)) throw new Error("ECONNREFUSED");
		if (opts.fail?.has(url)) return { ok: false, status: 500 };
		return { ok: true, status: 200 };
	};
	return { fetch, calls };
}

const LOCAL = "http://127.0.0.1:7890";

// ── 1 + 2. Loopback guard ─────────────────────────────────────────────

describe("loopback guard", () => {
	it("classifies loopback vs remote hosts", () => {
		expect(isLoopbackUrl("http://127.0.0.1:7890")).toBe(true);
		expect(isLoopbackUrl("http://localhost:7890")).toBe(true);
		expect(isLoopbackUrl("http://127.5.6.7:80")).toBe(true);
		expect(isLoopbackUrl("http://[::1]:7890")).toBe(true);
		expect(isLoopbackUrl("https://brain.example.com")).toBe(false);
		expect(isLoopbackUrl("http://10.0.0.5:7890")).toBe(false);
		expect(isLoopbackUrl("http://100.64.1.2:7890")).toBe(false); // tailnet, still remote
		expect(isLoopbackUrl("not a url")).toBe(false);
	});

	it("refuses a non-loopback relay by default (fail-closed)", () => {
		const { fetch } = recordingFetch();
		expect(() => new FlowBrainSyncClient({ baseUrl: "https://brain.example.com", fetch })).toThrow(
			/non-loopback/,
		);
	});

	it("allows a non-loopback relay only when allowRemote is set", () => {
		const { fetch } = recordingFetch();
		expect(
			() =>
				new FlowBrainSyncClient({ baseUrl: "http://100.64.1.2:7890", fetch, allowRemote: true }),
		).not.toThrow();
	});
});

// ── 3. Happy path ─────────────────────────────────────────────────────

describe("syncBundle", () => {
	it("POSTs entities then edges to the right endpoints", async () => {
		const { fetch, calls } = recordingFetch();
		const client = new FlowBrainSyncClient({ baseUrl: LOCAL, fetch });
		const subgraph: SubgraphResult = {
			entities: [makeEntity({ id: "ent_a", name: "a" }), makeEntity({ id: "ent_b", name: "b" })],
			relationships: [makeRel({ sourceId: "ent_a", targetId: "ent_b" })],
		};
		const report = await client.syncSubgraph(subgraph);

		expect(report.entitiesSynced).toBe(2);
		expect(report.edgesSynced).toBe(1);
		expect(report.entitiesFailed).toBe(0);
		expect(report.edgesFailed).toBe(0);
		expect(report.failures).toEqual([]);

		// entity POSTs precede the edge POST
		expect(calls[0].url).toBe(`${LOCAL}/brain/entity`);
		expect(calls[1].url).toBe(`${LOCAL}/brain/entity`);
		expect(calls[2].url).toBe(`${LOCAL}/brain/edge`);

		// edge references the deterministic ids of the two entities, not kernel ids
		const aId = toBrainEntity(subgraph.entities[0]).id;
		const bId = toBrainEntity(subgraph.entities[1]).id;
		expect(calls[2].body).toEqual({ src: aId, dst: bId, type: "relates_to" });
	});

	// ── 4. knownHashes cache ──────────────────────────────────────────

	it("skips an unchanged entity via knownHashes and still sends its edge", async () => {
		const { fetch, calls } = recordingFetch();
		const known = new Map<string, string>();
		const subgraph: SubgraphResult = {
			entities: [makeEntity({ id: "ent_a", name: "a" }), makeEntity({ id: "ent_b", name: "b" })],
			relationships: [makeRel({ sourceId: "ent_a", targetId: "ent_b" })],
		};

		// First run populates the cache.
		const client = new FlowBrainSyncClient({ baseUrl: LOCAL, fetch, knownHashes: known });
		const first = await client.syncSubgraph(subgraph);
		expect(first.entitiesSynced).toBe(2);
		expect(known.size).toBe(2);

		// Second run: content unchanged -> both entities skipped, edge still POSTed.
		calls.length = 0;
		const second = await client.syncSubgraph(subgraph);
		expect(second.entitiesSkipped).toBe(2);
		expect(second.entitiesSynced).toBe(0);
		expect(second.edgesSynced).toBe(1);
		// only the edge hit the network on the steady-state re-sync
		expect(calls.map((c) => c.url)).toEqual([`${LOCAL}/brain/edge`]);
	});

	it("re-syncs an entity whose content changed", async () => {
		const { fetch } = recordingFetch();
		const known = new Map<string, string>();
		const client = new FlowBrainSyncClient({ baseUrl: LOCAL, fetch, knownHashes: known });

		await client.syncSubgraph({ entities: [makeEntity({ id: "ent_a" })], relationships: [] });
		const changed = await client.syncSubgraph({
			entities: [makeEntity({ id: "ent_a", description: "now edited" })],
			relationships: [],
		});
		expect(changed.entitiesSynced).toBe(1);
		expect(changed.entitiesSkipped).toBe(0);
	});

	// ── 5. Fail-soft: failed entity suppresses its edge ───────────────

	it("does not send an edge whose endpoint entity failed, but continues", async () => {
		const bId = toBrainEntity(makeEntity({ id: "ent_b", name: "b" })).id;
		// Fail every entity POST, so ent_b never lands; the a->b edge must be held back.
		const { fetch } = recordingFetch({ fail: new Set([`${LOCAL}/brain/entity`]) });
		const client = new FlowBrainSyncClient({ baseUrl: LOCAL, fetch });
		const report = await client.syncSubgraph({
			entities: [makeEntity({ id: "ent_a", name: "a" }), makeEntity({ id: "ent_b", name: "b" })],
			relationships: [makeRel({ sourceId: "ent_a", targetId: "ent_b" })],
		});
		expect(report.entitiesFailed).toBe(2);
		expect(report.edgesSynced).toBe(0);
		expect(report.edgesFailed).toBe(1);
		expect(
			report.failures.some((f) => f.kind === "edge" && /endpoint not present/.test(f.error)),
		).toBe(true);
		expect(bId).toBeTruthy();
	});

	// ── 6. Edge POST failure ──────────────────────────────────────────

	it("records an edge POST failure", async () => {
		const { fetch } = recordingFetch({ fail: new Set([`${LOCAL}/brain/edge`]) });
		const client = new FlowBrainSyncClient({ baseUrl: LOCAL, fetch });
		const report = await client.syncSubgraph({
			entities: [makeEntity({ id: "ent_a", name: "a" }), makeEntity({ id: "ent_b", name: "b" })],
			relationships: [makeRel({ sourceId: "ent_a", targetId: "ent_b" })],
		});
		expect(report.entitiesSynced).toBe(2);
		expect(report.edgesSynced).toBe(0);
		expect(report.edgesFailed).toBe(1);
		expect(report.failures[0]).toMatchObject({ kind: "edge", error: "HTTP 500" });
	});

	// ── 7. Dangling edge dropped by the serializer ────────────────────

	it("counts a dangling edge as droppedEdges (serializer), not a failure", async () => {
		const { fetch } = recordingFetch();
		const client = new FlowBrainSyncClient({ baseUrl: LOCAL, fetch });
		const report = await client.syncSubgraph({
			entities: [makeEntity({ id: "ent_a", name: "a" })],
			// endpoint ent_zzz is not in the entity set
			relationships: [makeRel({ sourceId: "ent_a", targetId: "ent_zzz" })],
		});
		expect(report.entitiesSynced).toBe(1);
		expect(report.droppedEdges).toBe(1);
		expect(report.edgesSynced).toBe(0);
		expect(report.edgesFailed).toBe(0);
	});

	// ── 8. Network throw is caught ────────────────────────────────────

	it("catches a network throw per item (fail-soft)", async () => {
		const { fetch } = recordingFetch({ throwOn: new Set([`${LOCAL}/brain/entity`]) });
		const client = new FlowBrainSyncClient({ baseUrl: LOCAL, fetch });
		const report = await client.syncSubgraph({
			entities: [makeEntity({ id: "ent_a", name: "a" })],
			relationships: [],
		});
		expect(report.entitiesFailed).toBe(1);
		expect(report.failures[0]).toMatchObject({ kind: "entity", error: "ECONNREFUSED" });
	});
});

// ── syncProject wiring ────────────────────────────────────────────────

describe("syncProject", () => {
	it("queries the project subgraph and syncs it", async () => {
		const { fetch, calls } = recordingFetch();
		const client = new FlowBrainSyncClient({ baseUrl: LOCAL, fetch });
		// A minimal stand-in for KnowledgeGraph.query — exercises the wiring without
		// standing up a real SQLite graph.
		const subgraph: SubgraphResult = {
			entities: [makeEntity({ id: "ent_a", name: "a" })],
			relationships: [],
		};
		let seenProject = "";
		let seenLimit = -1;
		const fakeGraph = {
			query(pattern: { limit?: number }, projectId: string): SubgraphResult {
				seenProject = projectId;
				seenLimit = pattern.limit ?? -1;
				return subgraph;
			},
			// biome-ignore lint/suspicious/noExplicitAny: test stand-in for KnowledgeGraph
		} as any;

		const report: SyncReport = await client.syncProject(fakeGraph, "8gent-code", { limit: 250 });
		expect(seenProject).toBe("8gent-code");
		expect(seenLimit).toBe(250);
		expect(report.entitiesSynced).toBe(1);
		expect(calls[0].url).toBe(`${LOCAL}/brain/entity`);
	});
});
