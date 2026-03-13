/**
 * FS003 — State Machine Workflow Engine with Saga Compensation
 *
 * WORK_DIR contains: machine.ts, workflow.ts, process.ts (all LLM-generated)
 */
import { describe, test, expect, beforeEach } from "bun:test";

const workDir = process.env.WORK_DIR;
if (!workDir) throw new Error("WORK_DIR env var required");

const machineMod = await import(`${workDir}/machine.ts`);
const workflowMod = await import(`${workDir}/workflow.ts`);
const processMod = await import(`${workDir}/process.ts`);

const SMClass =
  machineMod.default ?? machineMod.StateMachine ?? machineMod.Machine;
const WFClass =
  workflowMod.default ?? workflowMod.WorkflowEngine ?? workflowMod.Workflow;
const createOrderWorkflow: Function =
  processMod.createOrderWorkflow ?? processMod.default?.createOrderWorkflow;
const createOrderSagaSteps: Function =
  processMod.createOrderSagaSteps ?? processMod.default?.createOrderSagaSteps;

if (!SMClass) throw new Error("machine.ts must export StateMachine");
if (!WFClass) throw new Error("workflow.ts must export WorkflowEngine");
if (!createOrderWorkflow) throw new Error("process.ts must export createOrderWorkflow");

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("FS003: State Machine", () => {
  // ── Core State Machine ──────────────────────────────────────────

  test("starts in initial state", () => {
    const def = createOrderWorkflow();
    const sm = new SMClass(def, {});
    const state = sm.state ?? sm.currentState ?? sm.getState?.();
    expect(state).toBe("idle");
  });

  test("transitions on valid event", () => {
    const def = createOrderWorkflow();
    const sm = new SMClass(def, { amount: 100 });

    const result = sm.send("validate");
    expect(result.success).toBe(true);

    const state = sm.state ?? sm.currentState ?? sm.getState?.();
    expect(state).toBe("validating");
  });

  test("rejects invalid event from current state", () => {
    const def = createOrderWorkflow();
    const sm = new SMClass(def, {});

    // Can't go straight to payment from idle
    const result = sm.send("pay");
    expect(result.success).toBe(false);

    const state = sm.state ?? sm.currentState ?? sm.getState?.();
    expect(state).toBe("idle");
  });

  test("guard prevents transition when condition not met", () => {
    const def = createOrderWorkflow();
    const sm = new SMClass(def, { amount: 0 });

    sm.send("validate");
    // Payment guard requires amount > 0
    const result = sm.send("pay");
    expect(result.success).toBe(false);
  });

  test("guard allows transition when condition met", () => {
    const def = createOrderWorkflow();
    const sm = new SMClass(def, { amount: 50 });

    sm.send("validate");
    const result = sm.send("pay");
    expect(result.success).toBe(true);

    const state = sm.state ?? sm.currentState ?? sm.getState?.();
    expect(state).toBe("payment");
  });

  test("actions update context on transition", () => {
    const def = createOrderWorkflow();
    const sm = new SMClass(def, { amount: 50 });

    sm.send("validate");
    const ctx = sm.context ?? sm.getContext?.();
    expect(ctx.validated).toBe(true);
  });

  test("full order flow: idle → validating → payment → fulfillment → completed", () => {
    const def = createOrderWorkflow();
    const sm = new SMClass(def, { amount: 100 });

    expect(sm.send("validate").success).toBe(true);
    expect(sm.send("pay").success).toBe(true);
    expect(sm.send("fulfill").success).toBe(true);
    expect(sm.send("complete").success).toBe(true);

    const state = sm.state ?? sm.currentState ?? sm.getState?.();
    expect(state).toBe("completed");

    const ctx = sm.context ?? sm.getContext?.();
    expect(ctx.validated).toBe(true);
    expect(ctx.paid).toBe(true);
    expect(ctx.shipped).toBe(true);
  });

  test("cancel works from any state", () => {
    const def = createOrderWorkflow();
    const sm = new SMClass(def, { amount: 100 });

    sm.send("validate");
    sm.send("pay");
    const result = sm.send("cancel");
    expect(result.success).toBe(true);

    const state = sm.state ?? sm.currentState ?? sm.getState?.();
    expect(state).toBe("cancelled");
  });

  test("canSend returns correct boolean", () => {
    const def = createOrderWorkflow();
    const sm = new SMClass(def, { amount: 100 });

    expect(sm.canSend("validate")).toBe(true);
    expect(sm.canSend("pay")).toBe(false);
  });

  test("history tracks transitions", () => {
    const def = createOrderWorkflow();
    const sm = new SMClass(def, { amount: 100 });

    sm.send("validate");
    sm.send("pay");

    const hist = sm.history ?? sm.getHistory?.();
    expect(hist.length).toBe(2);
    expect(hist[0].from).toBe("idle");
    expect(hist[0].to).toBe("validating");
    expect(hist[1].from).toBe("validating");
    expect(hist[1].to).toBe("payment");
  });
});

describe("FS003: Workflow Engine (Saga)", () => {
  test("successful workflow returns all results", async () => {
    const engine = new WFClass();
    const steps = [
      {
        name: "step1",
        execute: async () => "result1",
        compensate: async () => {},
      },
      {
        name: "step2",
        execute: async () => "result2",
        compensate: async () => {},
      },
    ];

    const result = await engine.execute(steps);
    expect(result.success).toBe(true);
    // results can be Map or plain object
    const r1 = result.results instanceof Map
      ? result.results.get("step1")
      : result.results?.step1;
    expect(r1).toBe("result1");
  });

  test("failed step triggers compensation in reverse", async () => {
    const compensated: string[] = [];

    const steps = [
      {
        name: "A",
        execute: async () => "a-done",
        compensate: async () => { compensated.push("A"); },
      },
      {
        name: "B",
        execute: async () => "b-done",
        compensate: async () => { compensated.push("B"); },
      },
      {
        name: "C",
        execute: async () => { throw new Error("C failed"); },
        compensate: async () => { compensated.push("C"); },
      },
    ];

    const engine = new WFClass();
    const result = await engine.execute(steps);

    expect(result.success).toBe(false);
    expect(result.failedStep ?? result.error).toBeDefined();

    // B and A should be compensated (in reverse), NOT C
    expect(compensated).toContain("B");
    expect(compensated).toContain("A");
    // Verify reverse order
    expect(compensated.indexOf("B")).toBeLessThan(compensated.indexOf("A"));
  });

  test("compensation only runs for completed steps", async () => {
    const compensated: string[] = [];

    const steps = [
      {
        name: "X",
        execute: async () => "x-done",
        compensate: async () => { compensated.push("X"); },
      },
      {
        name: "Y",
        execute: async () => { throw new Error("Y failed"); },
        compensate: async () => { compensated.push("Y"); },
      },
      {
        name: "Z",
        execute: async () => "z-done",
        compensate: async () => { compensated.push("Z"); },
      },
    ];

    const engine = new WFClass();
    await engine.execute(steps);

    // Only X was completed, Y failed, Z never ran
    expect(compensated).toContain("X");
    expect(compensated).not.toContain("Z");
  });
});

describe("FS003: Order Saga Steps", () => {
  test("order saga steps are well-formed", () => {
    if (!createOrderSagaSteps) return;

    const steps = createOrderSagaSteps({ orderId: "123", amount: 50 });
    expect(Array.isArray(steps)).toBe(true);
    expect(steps.length).toBeGreaterThanOrEqual(2);

    for (const step of steps) {
      expect(typeof step.name).toBe("string");
      expect(typeof step.execute).toBe("function");
      expect(typeof step.compensate).toBe("function");
    }
  });

  test("order saga executes successfully with valid context", async () => {
    if (!createOrderSagaSteps) return;

    const steps = createOrderSagaSteps({ orderId: "456", amount: 100 });
    const engine = new WFClass();
    const result = await engine.execute(steps);
    expect(result.success).toBe(true);
  });
});
