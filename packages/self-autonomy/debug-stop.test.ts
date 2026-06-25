import { describe, expect, it } from "bun:test";
import {
  initLoopState,
  shouldStop,
  LoopController,
  type LoopStopCondition,
} from "./improvement-loop";
import { resetDb } from "./evolution-db";

function makeIter(avgScore: number) {
  return {
    iteration: 0,
    avgScore,
    passing: avgScore >= 80 ? 1 : 0,
    total: 1,
    scores: { FOO: avgScore },
    mutationsAdded: [],
    timestamp: new Date().toISOString(),
  };
}

describe("DEBUG shouldStop", () => {
  it("max_turns at boundary", () => {
    const state = { ...initLoopState(), turns: 10 };
    const result = shouldStop(state, { maxTurns: 10 }, 0);
    console.log("max_turns:", JSON.stringify(result));
    expect(result.stop).toBe(true);
  });

  it("goal_score_threshold", () => {
    const state = initLoopState();
    const result = shouldStop(state, { goalScoreThreshold: 95 }, 96);
    console.log("goal_score_threshold:", JSON.stringify(result));
    expect(result.stop).toBe(true);
  });
});

describe("DEBUG LoopController", () => {
  it("maxTurns=3", () => {
    const ctrl = new LoopController({ maxTurns: 3 });
    console.log("Init: stopped=", ctrl.stopped);
    ctrl.advance(makeIter(50));
    console.log("After 1: stopped=", ctrl.stopped, "turns=", ctrl.currentState.turns);
    ctrl.advance(makeIter(50));
    console.log("After 2: stopped=", ctrl.stopped, "turns=", ctrl.currentState.turns);
    ctrl.advance(makeIter(50));
    console.log("After 3: stopped=", ctrl.stopped, "turns=", ctrl.currentState.turns);
    ctrl.advance(makeIter(50));
    console.log("After 4: stopped=", ctrl.stopped);
    expect(ctrl.stopped).toBe(true);
    expect(ctrl.stopReason?.type).toBe("max_turns");
  });

  it("goal threshold early exit", () => {
    const ctrl = new LoopController({ maxTurns: 20, goalScoreThreshold: 90 });
    console.log("Init: stopped=", ctrl.stopped);
    ctrl.advance(makeIter(50));
    console.log("After 1 (50): stopped=", ctrl.stopped, "turns=", ctrl.currentState.turns, "stall=", ctrl.currentState.stallCount);
    ctrl.advance(makeIter(50));
    console.log("After 2 (50): stopped=", ctrl.stopped, "turns=", ctrl.currentState.turns, "stall=", ctrl.currentState.stallCount);
    ctrl.advance(makeIter(95));
    console.log("After 3 (95): stopped=", ctrl.stopped, "turns=", ctrl.currentState.turns, "stall=", ctrl.currentState.stallCount);
    ctrl.advance(makeIter(50));
    console.log("After 4 (50): stopped=", ctrl.stopped, "turns=", ctrl.currentState.turns, "stall=", ctrl.currentState.stallCount);
    expect(ctrl.stopped).toBe(true);
    expect(ctrl.stopReason?.type).toBe("goal_score_threshold");
  });
});
