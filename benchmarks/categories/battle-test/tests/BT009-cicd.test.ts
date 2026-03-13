import { describe, it, expect, beforeEach } from "bun:test";
import * as path from "path";

const WORK_DIR = process.env.WORK_DIR || path.dirname(process.env.FIXTURE_PATH || ".");

let pipeline: any, stage: any, runner: any;

beforeEach(async () => {
  try {
    pipeline = await import(path.join(WORK_DIR, "pipeline.ts"));
    stage = await import(path.join(WORK_DIR, "stage.ts"));
    runner = await import(path.join(WORK_DIR, "runner.ts"));
  } catch {}
});

describe("Pipeline", () => {
  it("addStage adds stages to pipeline", () => {
    const Pipeline = pipeline.Pipeline || pipeline.default;
    const p = new Pipeline("my-pipeline");
    p.addStage("build", []);
    p.addStage("test", ["build"]);
    expect(p.stages.length || p.getStages().length).toBe(2);
  });

  it("validate passes for valid DAG", () => {
    const Pipeline = pipeline.Pipeline || pipeline.default;
    const p = new Pipeline("my-pipeline");
    p.addStage("build", []);
    p.addStage("test", ["build"]);
    p.addStage("deploy", ["test"]);
    const result = p.validate();
    expect(result.valid).toBe(true);
  });

  it("validate fails for cycles", () => {
    const Pipeline = pipeline.Pipeline || pipeline.default;
    const p = new Pipeline("my-pipeline");
    p.addStage("a", ["c"]);
    p.addStage("b", ["a"]);
    p.addStage("c", ["b"]);
    const result = p.validate();
    expect(result.valid).toBe(false);
  });

  it("toYAML returns valid YAML-like string", () => {
    const Pipeline = pipeline.Pipeline || pipeline.default;
    const p = new Pipeline("my-pipeline");
    p.addStage("build", []);
    p.addStage("test", ["build"]);
    const yaml = p.toYAML();
    expect(typeof yaml).toBe("string");
    expect(yaml).toContain("build");
    expect(yaml).toContain("test");
  });

  it("toJSON returns parseable JSON", () => {
    const Pipeline = pipeline.Pipeline || pipeline.default;
    const p = new Pipeline("my-pipeline");
    p.addStage("build", []);
    const json = p.toJSON();
    const parsed = JSON.parse(json);
    expect(parsed).toHaveProperty("name");
  });

  it("getDependencyOrder returns topological order", () => {
    const Pipeline = pipeline.Pipeline || pipeline.default;
    const p = new Pipeline("my-pipeline");
    p.addStage("deploy", ["test"]);
    p.addStage("test", ["build"]);
    p.addStage("build", []);
    const order = p.getDependencyOrder();
    expect(order.indexOf("build")).toBeLessThan(order.indexOf("test"));
    expect(order.indexOf("test")).toBeLessThan(order.indexOf("deploy"));
  });
});

describe("Stage", () => {
  it("constructor sets name", () => {
    const Stage = stage.Stage || stage.default;
    const s = new Stage("build");
    expect(s.name).toBe("build");
  });

  it("dependsOn creates dependency", () => {
    const Stage = stage.Stage || stage.default;
    const s = new Stage("test");
    s.dependsOn("build");
    const deps = s.dependencies || s.getDependencies();
    expect(deps).toContain("build");
  });

  it("addStep adds steps", () => {
    const Stage = stage.Stage || stage.default;
    const s = new Stage("build");
    s.addStep("install", () => {});
    s.addStep("compile", () => {});
    const steps = s.steps || s.getSteps();
    expect(steps.length).toBe(2);
  });

  it("addCondition sets condition", () => {
    const Stage = stage.Stage || stage.default;
    const s = new Stage("deploy");
    s.addCondition("branch", "main");
    const condition = s.conditions || s.getConditions();
    expect(condition.length || Object.keys(condition).length).toBeGreaterThan(0);
  });

  it("clone creates deep copy", () => {
    const Stage = stage.Stage || stage.default;
    const s = new Stage("build");
    s.addStep("install", () => {});
    const cloned = s.clone();
    expect(cloned.name).toBe("build");
    expect(cloned).not.toBe(s);
  });
});

describe("Pipeline Runner", () => {
  it("dryRun returns execution plan", () => {
    const Runner = runner.Runner || runner.default;
    const Pipeline = pipeline.Pipeline || pipeline.default;
    const p = new Pipeline("my-pipeline");
    p.addStage("build", []);
    p.addStage("test", ["build"]);
    const r = new Runner(p);
    const plan = r.dryRun();
    expect(plan.length).toBeGreaterThan(0);
  });

  it("execute calls stepFn for each step", async () => {
    const Runner = runner.Runner || runner.default;
    const Pipeline = pipeline.Pipeline || pipeline.default;
    const p = new Pipeline("my-pipeline");
    p.addStage("build", []);
    const r = new Runner(p);
    let called = false;
    await r.execute({ onStep: () => { called = true; } });
    expect(called).toBe(true);
  });

  it("getStatus returns stage statuses", async () => {
    const Runner = runner.Runner || runner.default;
    const Pipeline = pipeline.Pipeline || pipeline.default;
    const p = new Pipeline("my-pipeline");
    p.addStage("build", []);
    const r = new Runner(p);
    await r.execute();
    const status = r.getStatus();
    expect(status).toHaveProperty("build");
  });

  it("onStageComplete callback fires", async () => {
    const Runner = runner.Runner || runner.default;
    const Pipeline = pipeline.Pipeline || pipeline.default;
    const p = new Pipeline("my-pipeline");
    p.addStage("build", []);
    const r = new Runner(p);
    const completed: string[] = [];
    r.onStageComplete((name: string) => completed.push(name));
    await r.execute();
    expect(completed).toContain("build");
  });
});
