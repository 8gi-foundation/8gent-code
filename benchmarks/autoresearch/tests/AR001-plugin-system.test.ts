/**
 * AR001 — Plugin System with Dependency Resolution
 *
 * No fixtures — the LLM must create everything from scratch.
 * WORK_DIR contains: types.ts, resolver.ts, registry.ts, manager.ts (all LLM-generated)
 *
 * Tests: diamond deps, circular detection, lifecycle ordering, lazy loading,
 * hot-reload, optional deps, duplicate registration, stop idempotency, provides/requires.
 */
import { describe, test, expect, beforeEach } from "bun:test";

const workDir = process.env.WORK_DIR;
if (!workDir) throw new Error("WORK_DIR env var required");

// ── Import LLM-generated modules ───────────────────────────────────────

const typesMod = await import(`${workDir}/types.ts`);
const resolverMod = await import(`${workDir}/resolver.ts`);
const registryMod = await import(`${workDir}/registry.ts`);
const managerMod = await import(`${workDir}/manager.ts`);

const ResolverClass =
  resolverMod.default ?? resolverMod.Resolver ?? resolverMod.DependencyResolver ?? resolverMod.PluginResolver;
const RegistryClass =
  registryMod.default ?? registryMod.Registry ?? registryMod.PluginRegistry;
const ManagerClass =
  managerMod.default ?? managerMod.Manager ?? managerMod.PluginManager;

if (!ResolverClass) throw new Error("resolver.ts must export Resolver, DependencyResolver, PluginResolver, or default");
if (!RegistryClass) throw new Error("registry.ts must export Registry, PluginRegistry, or default");
if (!ManagerClass) throw new Error("manager.ts must export Manager, PluginManager, or default");

// ── Mock Plugin Factory ────────────────────────────────────────────────

interface LifecycleTracker {
  initCount: number;
  startCount: number;
  stopCount: number;
  initOrder: number;
  stopOrder: number;
}

let globalInitCounter = 0;
let globalStopCounter = 0;

function resetCounters() {
  globalInitCounter = 0;
  globalStopCounter = 0;
}

function makePlugin(
  name: string,
  deps: string[] = [],
  opts: { provides?: string[]; requires?: string[]; optional?: string[] } = {}
) {
  const tracker: LifecycleTracker = {
    initCount: 0,
    startCount: 0,
    stopCount: 0,
    initOrder: -1,
    stopOrder: -1,
  };

  const plugin: Record<string, any> = {
    name,
    dependencies: deps,
    provides: opts.provides ?? [],
    requires: opts.requires ?? [],
    // Support both "optionalDependencies" and "optional" naming
    optionalDependencies: opts.optional ?? [],
    optional: opts.optional ?? [],
    tracker,

    init: async (context?: any) => {
      tracker.initCount++;
      tracker.initOrder = globalInitCounter++;
    },
    start: async (context?: any) => {
      tracker.startCount++;
    },
    stop: async (context?: any) => {
      tracker.stopCount++;
      tracker.stopOrder = globalStopCounter++;
    },
  };

  return { plugin, tracker };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("AR001: Plugin System", () => {
  beforeEach(() => {
    resetCounters();
  });

  // ── 1. Diamond Dependency Resolution ─────────────────────────────

  test("diamond dependency resolution", async () => {
    // A -> [B, C], B -> [D], C -> [D], E standalone
    const { plugin: pluginD, tracker: tD } = makePlugin("D");
    const { plugin: pluginB, tracker: tB } = makePlugin("B", ["D"]);
    const { plugin: pluginC, tracker: tC } = makePlugin("C", ["D"]);
    const { plugin: pluginA, tracker: tA } = makePlugin("A", ["B", "C"]);
    const { plugin: pluginE, tracker: tE } = makePlugin("E");

    const registry = new RegistryClass();
    registry.register(pluginA);
    registry.register(pluginB);
    registry.register(pluginC);
    registry.register(pluginD);
    registry.register(pluginE);

    const resolver = new ResolverClass(registry);
    const order: string[] = resolver.resolve();

    // D must come before B and C
    const idxD = order.indexOf("D");
    const idxB = order.indexOf("B");
    const idxC = order.indexOf("C");
    const idxA = order.indexOf("A");
    const idxE = order.indexOf("E");

    expect(idxD).not.toBe(-1);
    expect(idxB).not.toBe(-1);
    expect(idxC).not.toBe(-1);
    expect(idxA).not.toBe(-1);
    expect(idxE).not.toBe(-1);

    expect(idxD).toBeLessThan(idxB);
    expect(idxD).toBeLessThan(idxC);
    expect(idxB).toBeLessThan(idxA);
    expect(idxC).toBeLessThan(idxA);

    // All 5 plugins present
    expect(order.length).toBe(5);
  });

  // ── 2. Circular Dependency Detection ─────────────────────────────

  test("circular dependency detection", () => {
    const { plugin: pluginA } = makePlugin("A", ["B"]);
    const { plugin: pluginB } = makePlugin("B", ["C"]);
    const { plugin: pluginC } = makePlugin("C", ["A"]);

    const registry = new RegistryClass();
    registry.register(pluginA);
    registry.register(pluginB);
    registry.register(pluginC);

    const resolver = new ResolverClass(registry);

    expect(() => resolver.resolve()).toThrow(
      /circular|cycle/i
    );
  });

  // ── 3. Lifecycle Ordering ────────────────────────────────────────

  test("lifecycle ordering: init in dep order, stop in reverse", async () => {
    const { plugin: pluginD, tracker: tD } = makePlugin("D");
    const { plugin: pluginB, tracker: tB } = makePlugin("B", ["D"]);
    const { plugin: pluginA, tracker: tA } = makePlugin("A", ["B"]);

    const manager = new ManagerClass();
    manager.register(pluginA);
    manager.register(pluginB);
    manager.register(pluginD);

    await manager.initAll();

    // Init order: D -> B -> A
    expect(tD.initOrder).toBeLessThan(tB.initOrder);
    expect(tB.initOrder).toBeLessThan(tA.initOrder);
    expect(tD.initCount).toBe(1);
    expect(tB.initCount).toBe(1);
    expect(tA.initCount).toBe(1);

    await manager.stopAll();

    // Stop order: A -> B -> D (reverse of init)
    expect(tA.stopOrder).toBeLessThan(tB.stopOrder);
    expect(tB.stopOrder).toBeLessThan(tD.stopOrder);
  });

  // ── 4. Lazy Loading ──────────────────────────────────────────────

  test("lazy loading triggers dependency chain on getPlugin", async () => {
    const { plugin: pluginD, tracker: tD } = makePlugin("D");
    const { plugin: pluginB, tracker: tB } = makePlugin("B", ["D"]);
    const { plugin: pluginC, tracker: tC } = makePlugin("C", ["D"]);
    const { plugin: pluginA, tracker: tA } = makePlugin("A", ["B", "C"]);

    const manager = new ManagerClass();
    manager.register(pluginA);
    manager.register(pluginB);
    manager.register(pluginC);
    manager.register(pluginD);

    // Do NOT call initAll — lazy load instead
    // Getting A should trigger init of D, B, C, then A
    const result = await manager.getPlugin("A");

    expect(result).toBeDefined();
    expect(tD.initCount).toBe(1);
    expect(tB.initCount).toBe(1);
    expect(tC.initCount).toBe(1);
    expect(tA.initCount).toBe(1);

    // D must init before B and C, B and C before A
    expect(tD.initOrder).toBeLessThan(tB.initOrder);
    expect(tD.initOrder).toBeLessThan(tC.initOrder);
    expect(tB.initOrder).toBeLessThan(tA.initOrder);
    expect(tC.initOrder).toBeLessThan(tA.initOrder);
  });

  // ── 5. Hot-Reload ───────────────────────────────────────────────

  test("hot-reload cascades to dependents but not unrelated", async () => {
    const { plugin: pluginD, tracker: tD } = makePlugin("D");
    const { plugin: pluginB, tracker: tB } = makePlugin("B", ["D"]);
    const { plugin: pluginC, tracker: tC } = makePlugin("C", ["D"]);
    const { plugin: pluginA, tracker: tA } = makePlugin("A", ["B", "C"]);
    const { plugin: pluginE, tracker: tE } = makePlugin("E");

    const manager = new ManagerClass();
    manager.register(pluginA);
    manager.register(pluginB);
    manager.register(pluginC);
    manager.register(pluginD);
    manager.register(pluginE);

    await manager.initAll();

    // All should have init count 1
    expect(tD.initCount).toBe(1);
    expect(tB.initCount).toBe(1);
    expect(tC.initCount).toBe(1);
    expect(tA.initCount).toBe(1);
    expect(tE.initCount).toBe(1);

    // Reload D — should cascade to B, C, A but NOT E
    await manager.reload("D");

    expect(tD.initCount).toBe(2);
    expect(tB.initCount).toBe(2);
    expect(tC.initCount).toBe(2);
    expect(tA.initCount).toBe(2);
    expect(tE.initCount).toBe(1); // E untouched
  });

  // ── 6. Optional Dependencies ────────────────────────────────────

  test("optional dependency missing does not prevent load", async () => {
    const { plugin: pluginD, tracker: tD } = makePlugin("D");
    const { plugin: pluginF, tracker: tF } = makePlugin("F", ["D"], {
      optional: ["missing"],
    });

    // Also set dependencies to only required ones for resolvers that
    // separate required vs optional
    pluginF.dependencies = ["D"];

    const manager = new ManagerClass();
    manager.register(pluginD);
    manager.register(pluginF);

    // Should NOT throw — "missing" is optional
    await manager.initAll();

    expect(tD.initCount).toBe(1);
    expect(tF.initCount).toBe(1);
  });

  // ── 7. Duplicate Registration ───────────────────────────────────

  test("duplicate registration throws", () => {
    const { plugin: pluginA1 } = makePlugin("A");
    const { plugin: pluginA2 } = makePlugin("A");

    const registry = new RegistryClass();
    registry.register(pluginA1);

    expect(() => registry.register(pluginA2)).toThrow();
  });

  // ── 8. Stop Idempotency ─────────────────────────────────────────

  test("calling stopAll twice does not error", async () => {
    const { plugin: pluginA, tracker: tA } = makePlugin("A");

    const manager = new ManagerClass();
    manager.register(pluginA);
    await manager.initAll();

    await manager.stopAll();
    // Second stop should not throw
    await manager.stopAll();

    // Stop may be called once or twice, but it must not throw
    expect(tA.stopCount).toBeGreaterThanOrEqual(1);
  });

  // ── 9. Plugin Provides/Requires ─────────────────────────────────

  test("resolver maps requires to provides", () => {
    const { plugin: pluginB } = makePlugin("B", [], {
      provides: ["auth"],
    });
    const { plugin: pluginA } = makePlugin("A", [], {
      requires: ["auth"],
    });

    const registry = new RegistryClass();
    registry.register(pluginA);
    registry.register(pluginB);

    const resolver = new ResolverClass(registry);
    const order: string[] = resolver.resolve();

    const idxA = order.indexOf("A");
    const idxB = order.indexOf("B");

    expect(idxA).not.toBe(-1);
    expect(idxB).not.toBe(-1);

    // B provides "auth", A requires "auth" → B must come before A
    expect(idxB).toBeLessThan(idxA);
  });
});
