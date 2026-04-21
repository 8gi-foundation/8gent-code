/**
 * Tests for AccessAuditStore.
 * Covers: insert+read, query by target/actor/time, append-only invariant, input validation.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { AccessAuditStore } from "./store.js";

let store: AccessAuditStore;
let dbPath: string;

beforeEach(() => {
  dbPath = `/tmp/audit-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`;
  store = new AccessAuditStore(dbPath);
});

afterEach(() => {
  store.close();
  for (const ext of ["", "-wal", "-shm"]) {
    const p = dbPath + ext;
    if (existsSync(p)) { try { unlinkSync(p); } catch { /* best effort */ } }
  }
});

describe("AccessAuditStore", () => {
  it("inserts and reads back an event", () => {
    const id = store.logAccess({
      actor: "agent:speech-coach", actorKind: "agent",
      targetTable: "child_profile", targetId: "child_123",
      operation: "read", reason: "render home screen", sessionId: "s_abc",
    });
    expect(id).toMatch(/^aud_/);

    const events = store.queryAccess({ targetId: "child_123" });
    expect(events.length).toBe(1);
    expect(events[0].actor).toBe("agent:speech-coach");
    expect(events[0].actorKind).toBe("agent");
    expect(events[0].targetTable).toBe("child_profile");
    expect(events[0].operation).toBe("read");
    expect(events[0].reason).toBe("render home screen");
    expect(events[0].sessionId).toBe("s_abc");
    expect(events[0].createdAt).toBeGreaterThan(0);
  });

  it("queries by actor", () => {
    store.logAccess({ actor: "human:parent_1", actorKind: "human", targetTable: "child_profile", targetId: "c1", operation: "read",   reason: "settings" });
    store.logAccess({ actor: "human:parent_2", actorKind: "human", targetTable: "child_profile", targetId: "c2", operation: "read",   reason: "settings" });
    store.logAccess({ actor: "human:parent_1", actorKind: "human", targetTable: "vocabulary",    targetId: "v1", operation: "export", reason: "export" });
    const events = store.queryAccess({ actor: "human:parent_1" });
    expect(events.length).toBe(2);
    for (const e of events) expect(e.actor).toBe("human:parent_1");
  });

  it("queries by time range", async () => {
    const t0 = Date.now();
    store.logAccess({ actor: "system:backup", actorKind: "system", targetTable: "child_profile", targetId: "c1", operation: "export", reason: "nightly" });
    await new Promise((r) => setTimeout(r, 10));
    const mid = Date.now();
    await new Promise((r) => setTimeout(r, 10));
    store.logAccess({ actor: "system:backup", actorKind: "system", targetTable: "child_profile", targetId: "c2", operation: "export", reason: "nightly" });

    const before = store.queryAccess({ since: t0, until: mid });
    const after = store.queryAccess({ since: mid });
    expect(before.length).toBe(1);
    expect(before[0].targetId).toBe("c1");
    expect(after.length).toBe(1);
    expect(after[0].targetId).toBe("c2");
  });

  it("queries by targetTable", () => {
    store.logAccess({ actor: "a", actorKind: "agent", targetTable: "child_profile", targetId: "c1", operation: "read", reason: "r" });
    store.logAccess({ actor: "a", actorKind: "agent", targetTable: "transcripts",  targetId: "t1", operation: "read", reason: "r" });
    const profiles = store.queryAccess({ targetTable: "child_profile" });
    expect(profiles.length).toBe(1);
    expect(profiles[0].targetTable).toBe("child_profile");
  });

  it("is append-only - no public mutation API", () => {
    store.logAccess({ actor: "a", actorKind: "agent", targetTable: "child_profile", targetId: "c1", operation: "read", reason: "r" });
    const surface = store as unknown as Record<string, unknown>;
    expect(typeof surface.update).toBe("undefined");
    expect(typeof surface.delete).toBe("undefined");
    expect(typeof surface.remove).toBe("undefined");
    expect(typeof surface.clear).toBe("undefined");
    expect(typeof surface.truncate).toBe("undefined");
    expect(store.count()).toBe(1);
  });

  it("rejects invalid input", () => {
    const base = { actor: "a", actorKind: "agent" as const, targetTable: "t", targetId: "id", operation: "read" as const, reason: "r" };
    expect(() => store.logAccess({ ...base, actor: "" })).toThrow(/actor is required/);
    // @ts-expect-error - deliberately wrong
    expect(() => store.logAccess({ ...base, actorKind: "robot" })).toThrow(/invalid actorKind/);
    // @ts-expect-error - deliberately wrong
    expect(() => store.logAccess({ ...base, operation: "write" })).toThrow(/invalid operation/);
  });
});
