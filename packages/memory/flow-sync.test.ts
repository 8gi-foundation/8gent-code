/**
 * Tests for the Flow brain_store bridge (flow-sync.ts).
 *
 * Covers:
 * 1. Entity field mapping onto the /brain/entity wire shape
 * 2. Deterministic id stability + idempotence (same identity -> same id)
 * 3. Edge remapping onto deterministic ids + dropping dangling edges
 * 4. Reverse map (brain entity -> kernel fields), incl. foreign-node rejection
 * 5. Content-hash parity with merge_brain.py (real Python ground-truth vectors)
 * 6. props canonicalization is key-order independent
 */

import { describe, expect, it } from "bun:test";
import {
	brainContentHash,
	deterministicEntityId,
	entityContentHash,
	fromBrainEntity,
	KERNEL_BRAIN_SOURCE,
	toBrainEntity,
	toBrainSyncBundle,
} from "./flow-sync.js";
import type { Entity, Relationship, SubgraphResult } from "./graph.js";

function makeEntity(overrides: Partial<Entity> = {}): Entity {
	const now = 1_700_000_000_000;
	return {
		id: "ent_abc123",
		projectId: "8gent-code",
		type: "concept",
		name: "Failover chain",
		description: "local 8gent -> qwen -> openrouter",
		metadata: undefined,
		firstSeen: now,
		lastSeen: now,
		mentionCount: 1,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function makeRel(overrides: Partial<Relationship> = {}): Relationship {
	const now = 1_700_000_000_000;
	return {
		id: "rel_1",
		projectId: "8gent-code",
		sourceId: "ent_a",
		targetId: "ent_b",
		type: "depends_on",
		strength: 1,
		metadata: undefined,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

describe("toBrainEntity", () => {
	it("maps kernel fields onto the /brain/entity wire shape", () => {
		const p = toBrainEntity(makeEntity());
		expect(p.label).toBe("Failover chain");
		expect(p.kind).toBe("concept");
		expect(p.detail).toBe("local 8gent -> qwen -> openrouter");
		expect(p.dimension).toBe("8gent-code");
		expect(p.source).toBe(KERNEL_BRAIN_SOURCE);
		expect(p.id).toMatch(/^k_[0-9a-f]{12}$/);
	});

	it("carries kernel-native fields + metadata in props for a lossless reverse map", () => {
		const p = toBrainEntity(makeEntity({ metadata: { url: "https://8gent.dev" } }));
		expect(p.props.kernelId).toBe("ent_abc123");
		expect(p.props.kernelType).toBe("concept");
		expect(p.props.projectId).toBe("8gent-code");
		expect(p.props.mentionCount).toBe(1);
		expect(p.props.url).toBe("https://8gent.dev");
	});

	it("uses an empty detail when the entity has no description", () => {
		const p = toBrainEntity(makeEntity({ description: undefined }));
		expect(p.detail).toBe("");
	});
});

describe("deterministicEntityId", () => {
	it("is stable across calls (idempotent sync)", () => {
		expect(deterministicEntityId("p", "concept", "X")).toBe(deterministicEntityId("p", "concept", "X"));
	});

	it("separates identity by project, type, and name", () => {
		const base = deterministicEntityId("p", "concept", "X");
		expect(deterministicEntityId("q", "concept", "X")).not.toBe(base);
		expect(deterministicEntityId("p", "tool", "X")).not.toBe(base);
		expect(deterministicEntityId("p", "concept", "Y")).not.toBe(base);
	});

	it("two entities with the same identity map to the same brain id", () => {
		const a = toBrainEntity(makeEntity({ id: "ent_1" }));
		const b = toBrainEntity(makeEntity({ id: "ent_2" })); // same project/type/name
		expect(a.id).toBe(b.id);
	});
});

describe("toBrainSyncBundle", () => {
	it("remaps edges onto deterministic ids and keeps the graph connected", () => {
		const a = makeEntity({ id: "ent_a", name: "A" });
		const b = makeEntity({ id: "ent_b", name: "B" });
		const sub: SubgraphResult = {
			entities: [a, b],
			relationships: [makeRel({ sourceId: "ent_a", targetId: "ent_b" })],
		};
		const bundle = toBrainSyncBundle(sub);
		expect(bundle.entities).toHaveLength(2);
		expect(bundle.edges).toHaveLength(1);
		expect(bundle.droppedEdges).toBe(0);
		expect(bundle.edges[0].src).toBe(deterministicEntityId("8gent-code", "concept", "A"));
		expect(bundle.edges[0].dst).toBe(deterministicEntityId("8gent-code", "concept", "B"));
		expect(bundle.edges[0].type).toBe("depends_on");
	});

	it("drops edges whose endpoint is outside the mapped entity set", () => {
		const a = makeEntity({ id: "ent_a", name: "A" });
		const sub: SubgraphResult = {
			entities: [a],
			relationships: [makeRel({ sourceId: "ent_a", targetId: "ent_missing" })],
		};
		const bundle = toBrainSyncBundle(sub);
		expect(bundle.edges).toHaveLength(0);
		expect(bundle.droppedEdges).toBe(1);
	});
});

describe("fromBrainEntity", () => {
	it("round-trips a kernel-authored entity", () => {
		const p = toBrainEntity(makeEntity());
		const back = fromBrainEntity(p);
		expect(back).not.toBeNull();
		expect(back?.name).toBe("Failover chain");
		expect(back?.type).toBe("concept");
		expect(back?.projectId).toBe("8gent-code");
		expect(back?.kernelId).toBe("ent_abc123");
	});

	it("rejects a foreign (non-kernel) brain node", () => {
		const foreign = { label: "Charles", kind: "person", detail: "", props: {} };
		expect(fromBrainEntity(foreign)).toBeNull();
	});
});

describe("brainContentHash — parity with merge_brain.py", () => {
	// Ground truth produced by running scripts/fleet/merge_brain.py `_content_hash`
	// against the real relay code (mac/relay/brain_store.py schema).
	it("V1: simple record", () => {
		expect(
			brainContentHash({
				kind: "concept",
				label: "Failover chain",
				detail: "local 8gent -> qwen -> openrouter",
				dimension: "8gent-code",
				source: "8gent-code",
				props: {},
			}),
		).toBe("e059448ce1246ff5eaaff55d");
	});

	it("V2: props are canonicalized key-order independent", () => {
		const expected = "191a6c66228ac9210c282cf4";
		expect(
			brainContentHash({
				kind: "decision",
				label: "Use Bun",
				detail: "runtime",
				dimension: "default",
				source: "8gent-code",
				props: { b: 2, a: 1 },
			}),
		).toBe(expected);
		// Same content, keys reversed -> identical hash.
		expect(
			brainContentHash({
				kind: "decision",
				label: "Use Bun",
				detail: "runtime",
				dimension: "default",
				source: "8gent-code",
				props: { a: 1, b: 2 },
			}),
		).toBe(expected);
	});

	it("V3: non-ASCII escapes like Python ensure_ascii", () => {
		expect(
			brainContentHash({
				kind: "note",
				label: "café résumé",
				detail: "ünïcode",
				dimension: "custom",
				source: "app",
				props: {},
			}),
		).toBe("9cc4dca3929745849b9915d8");
	});

	it("V4: missing fields hash as empty strings", () => {
		expect(brainContentHash({ label: "bare" })).toBe("eab3c8c7812e60ead60cdffd");
	});

	it("entityContentHash matches a mapped payload", () => {
		const p = toBrainEntity(makeEntity({ metadata: { a: 1 } }));
		expect(entityContentHash(p)).toBe(brainContentHash(p));
	});
});
