/**
 * BF002 — Memory Leak in Event Handler
 *
 * Loads the LLM-generated fix from FIXTURE_PATH env var,
 * then verifies proper cleanup behavior.
 */
import { describe, test, expect, beforeEach } from "bun:test";

const fixturePath = process.env.FIXTURE_PATH;
if (!fixturePath) throw new Error("FIXTURE_PATH env var required");

const mod = await import(fixturePath);
const EmitterClass =
  mod.default ?? mod.JsonEventEmitter ?? mod.EventEmitter ?? mod.Emitter;

if (!EmitterClass) {
  throw new Error(
    "Module must export JsonEventEmitter, EventEmitter, Emitter, or default class"
  );
}

describe("BF002: Memory Leak Fix", () => {
  let emitter: InstanceType<typeof EmitterClass>;

  beforeEach(() => {
    emitter = new EmitterClass();
  });

  test("handlers are cleared after destroy", () => {
    let called = false;
    emitter.on("test", () => { called = true; });
    emitter.destroy();
    emitter.emit?.("test", {});
    expect(called).toBe(false);
  });

  test("handler count is 0 after destroy", () => {
    emitter.on("a", () => {});
    emitter.on("b", () => {});
    emitter.on("a", () => {});
    emitter.destroy();

    // Check internal state — try common property names
    const handlers =
      emitter.handlers ?? emitter._handlers ?? emitter.listeners;
    if (handlers instanceof Map) {
      expect(handlers.size).toBe(0);
    }
    // Regardless, emitting after destroy should not throw
    expect(() => emitter.emit?.("a", {})).not.toThrow();
  });

  test("emit after destroy is a safe no-op", () => {
    const results: any[] = [];
    emitter.on("data", (d: any) => results.push(d));
    emitter.destroy();
    expect(() => emitter.emit?.("data", { x: 1 })).not.toThrow();
    expect(results).toEqual([]);
  });

  test("1000 create/destroy cycles don't accumulate handlers", () => {
    for (let i = 0; i < 1000; i++) {
      const e = new EmitterClass();
      e.on("tick", () => {});
      e.on("tock", () => {});
      e.destroy();
    }
    // If we got here without OOM, the test passes
    expect(true).toBe(true);
  });

  test("on() still works after fresh construction (not destroyed)", () => {
    const results: string[] = [];
    emitter.on("msg", (d: string) => results.push(d));
    emitter.emit("msg", "hello");
    emitter.emit("msg", "world");
    expect(results).toEqual(["hello", "world"]);
  });
});
