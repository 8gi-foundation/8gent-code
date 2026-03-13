import { describe, it, expect, beforeEach } from "bun:test";
import * as path from "path";

const WORK_DIR = process.env.WORK_DIR || path.dirname(process.env.FIXTURE_PATH || ".");

let machine: any, interpreter: any, guards: any, actions: any;

beforeEach(async () => {
  try {
    machine = await import(path.join(WORK_DIR, "machine.ts"));
    interpreter = await import(path.join(WORK_DIR, "interpreter.ts"));
    guards = await import(path.join(WORK_DIR, "guards.ts"));
    actions = await import(path.join(WORK_DIR, "actions.ts"));
  } catch {}
});

describe("State Machine", () => {
  it("creates a machine with initial state", () => {
    const createFn = machine.createMachine || machine.default;
    const m = createFn({
      id: "light",
      initial: "green",
      states: {
        green: { on: { TIMER: "yellow" } },
        yellow: { on: { TIMER: "red" } },
        red: { on: { TIMER: "green" } },
      },
    });
    expect(m.getInitialState()).toBe("green");
    expect(m.getStates()).toContain("green");
    expect(m.getStates()).toContain("yellow");
    expect(m.getStates()).toContain("red");
  });

  it("transitions between states", () => {
    const createFn = machine.createMachine || machine.default;
    const m = createFn({
      id: "light",
      initial: "green",
      states: {
        green: { on: { TIMER: "yellow" } },
        yellow: { on: { TIMER: "red" } },
        red: { on: { TIMER: "green" } },
      },
    });
    const result = m.transition("green", "TIMER");
    expect(result.value).toBe("yellow");
    expect(result.changed).toBe(true);
  });

  it("ignores unknown events", () => {
    const createFn = machine.createMachine || machine.default;
    const m = createFn({
      id: "light",
      initial: "green",
      states: {
        green: { on: { TIMER: "yellow" } },
        yellow: {},
      },
    });
    const result = m.transition("green", "UNKNOWN");
    expect(result.value).toBe("green");
    expect(result.changed).toBe(false);
  });

  it("getEvents returns available events", () => {
    const createFn = machine.createMachine || machine.default;
    const m = createFn({
      id: "test",
      initial: "idle",
      states: {
        idle: { on: { START: "running", RESET: "idle" } },
        running: { on: { STOP: "idle" } },
      },
    });
    const events = m.getEvents("idle");
    expect(events).toContain("START");
    expect(events).toContain("RESET");
  });
});

describe("Interpreter", () => {
  it("starts in initial state", () => {
    const createFn = machine.createMachine || machine.default;
    const Interp = interpreter.Interpreter || interpreter.default;
    const m = createFn({
      id: "test",
      initial: "idle",
      context: { count: 0 },
      states: { idle: { on: { GO: "running" } }, running: {} },
    });
    const interp = new Interp(m);
    interp.start();
    expect(interp.getState()).toBe("idle");
    expect(interp.getContext().count).toBe(0);
  });

  it("send transitions state", () => {
    const createFn = machine.createMachine || machine.default;
    const Interp = interpreter.Interpreter || interpreter.default;
    const m = createFn({
      id: "test",
      initial: "idle",
      context: {},
      states: { idle: { on: { GO: "active" } }, active: {} },
    });
    const interp = new Interp(m);
    interp.start();
    interp.send("GO");
    expect(interp.getState()).toBe("active");
  });

  it("subscribe notifies on transition", () => {
    const createFn = machine.createMachine || machine.default;
    const Interp = interpreter.Interpreter || interpreter.default;
    const m = createFn({
      id: "test",
      initial: "a",
      context: {},
      states: { a: { on: { NEXT: "b" } }, b: {} },
    });
    const interp = new Interp(m);
    interp.start();
    let notified = false;
    interp.subscribe((state: string) => { notified = true; });
    interp.send("NEXT");
    expect(notified).toBe(true);
  });

  it("matches works", () => {
    const createFn = machine.createMachine || machine.default;
    const Interp = interpreter.Interpreter || interpreter.default;
    const m = createFn({
      id: "test",
      initial: "idle",
      context: {},
      states: { idle: {}, active: {} },
    });
    const interp = new Interp(m);
    interp.start();
    expect(interp.matches("idle")).toBe(true);
    expect(interp.matches("active")).toBe(false);
  });
});

describe("Guards", () => {
  it("and combinator", () => {
    const andFn = guards.and || guards.default?.and;
    const guard = andFn(
      (ctx: any) => ctx.age > 18,
      (ctx: any) => ctx.verified === true
    );
    expect(guard({ age: 20, verified: true }, {})).toBe(true);
    expect(guard({ age: 20, verified: false }, {})).toBe(false);
    expect(guard({ age: 16, verified: true }, {})).toBe(false);
  });

  it("or combinator", () => {
    const orFn = guards.or || guards.default?.or;
    const guard = orFn(
      (ctx: any) => ctx.role === "admin",
      (ctx: any) => ctx.role === "editor"
    );
    expect(guard({ role: "admin" }, {})).toBe(true);
    expect(guard({ role: "editor" }, {})).toBe(true);
    expect(guard({ role: "viewer" }, {})).toBe(false);
  });

  it("not combinator", () => {
    const notFn = guards.not || guards.default?.not;
    const guard = notFn((ctx: any) => ctx.blocked);
    expect(guard({ blocked: false }, {})).toBe(true);
    expect(guard({ blocked: true }, {})).toBe(false);
  });

  it("equals guard", () => {
    const equalsFn = guards.equals || guards.default?.equals;
    const guard = equalsFn("status", "active");
    expect(guard({ status: "active" }, {})).toBe(true);
    expect(guard({ status: "inactive" }, {})).toBe(false);
  });
});

describe("Actions", () => {
  it("assign creates new context", () => {
    const assignFn = actions.assign || actions.default?.assign;
    const action = assignFn({ count: 5 });
    const newCtx = action.exec({ count: 0, name: "test" }, {});
    expect(newCtx.count).toBe(5);
    expect(newCtx.name).toBe("test");
  });

  it("assign with function", () => {
    const assignFn = actions.assign || actions.default?.assign;
    const action = assignFn((ctx: any) => ({ count: ctx.count + 1 }));
    const newCtx = action.exec({ count: 10 }, {});
    expect(newCtx.count).toBe(11);
  });

  it("assign is immutable", () => {
    const assignFn = actions.assign || actions.default?.assign;
    const action = assignFn({ x: 2 });
    const original = { x: 1, y: 3 };
    const result = action.exec(original, {});
    expect(result.x).toBe(2);
    expect(original.x).toBe(1); // original unchanged
  });

  it("log action has correct type", () => {
    const logFn = actions.log || actions.default?.log;
    const action = logFn("hello");
    expect(action.type).toBe("log");
  });
});

describe("Guards in Transitions", () => {
  it("guard blocks transition when false", () => {
    const createFn = machine.createMachine || machine.default;
    const m = createFn({
      id: "door",
      initial: "locked",
      context: { hasKey: false },
      states: {
        locked: {
          on: {
            UNLOCK: {
              target: "unlocked",
              guard: (ctx: any) => ctx.hasKey === true,
            },
          },
        },
        unlocked: {},
      },
    });
    const result = m.transition("locked", "UNLOCK", { hasKey: false });
    expect(result.value).toBe("locked");
    expect(result.changed).toBe(false);
  });

  it("guard allows transition when true", () => {
    const createFn = machine.createMachine || machine.default;
    const m = createFn({
      id: "door",
      initial: "locked",
      context: { hasKey: true },
      states: {
        locked: {
          on: {
            UNLOCK: {
              target: "unlocked",
              guard: (ctx: any) => ctx.hasKey === true,
            },
          },
        },
        unlocked: {},
      },
    });
    const result = m.transition("locked", "UNLOCK", { hasKey: true });
    expect(result.value).toBe("unlocked");
    expect(result.changed).toBe(true);
  });
});
