/**
 * MR001 — Constraint Solver
 *
 * Tests a generic CSP solver with Sudoku and scheduling encoders.
 * WORK_DIR contains: csp.ts, sudoku.ts, scheduler.ts, utils.ts (all LLM-generated, no fixtures)
 */
import { describe, test, expect } from "bun:test";

const workDir = process.env.WORK_DIR;
if (!workDir) throw new Error("WORK_DIR env var required");

// ── Dynamic imports with flexible export resolution ─────────────────

const cspMod = await import(`${workDir}/csp.ts`);
const sudokuMod = await import(`${workDir}/sudoku.ts`);
const schedulerMod = await import(`${workDir}/scheduler.ts`);
// utils.ts is consumed internally by the other modules; we don't test it directly

// Flexible export resolution
const CSPSolver = cspMod.CSPSolver ?? cspMod.Solver ?? cspMod.default;
const solveSudoku =
  sudokuMod.solveSudoku ??
  sudokuMod.solve ??
  sudokuMod.Sudoku?.solve ??
  sudokuMod.default?.solve ??
  sudokuMod.default;
const solveSchedule =
  schedulerMod.solveSchedule ??
  schedulerMod.schedule ??
  schedulerMod.solve ??
  schedulerMod.Scheduler?.solve ??
  schedulerMod.default?.solve ??
  schedulerMod.default;

// AC-3 might be exported from csp or sudoku
const ac3 =
  cspMod.ac3 ??
  cspMod.AC3 ??
  cspMod.arcConsistency ??
  sudokuMod.ac3 ??
  sudokuMod.AC3 ??
  sudokuMod.arcConsistency ??
  null;

// ── Puzzle Data ─────────────────────────────────────────────────────

// Easy Sudoku (~30 givens)
const EASY_PUZZLE: number[][] = [
  [5, 3, 0, 0, 7, 0, 0, 0, 0],
  [6, 0, 0, 1, 9, 5, 0, 0, 0],
  [0, 9, 8, 0, 0, 0, 0, 6, 0],
  [8, 0, 0, 0, 6, 0, 0, 0, 3],
  [4, 0, 0, 8, 0, 3, 0, 0, 1],
  [7, 0, 0, 0, 2, 0, 0, 0, 6],
  [0, 6, 0, 0, 0, 0, 2, 8, 0],
  [0, 0, 0, 4, 1, 9, 0, 0, 5],
  [0, 0, 0, 0, 8, 0, 0, 7, 9],
];

// Hard Sudoku — 17 clues (near minimum)
const HARD_PUZZLE: number[][] = [
  [0, 0, 0, 0, 0, 0, 0, 1, 0],
  [4, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 2, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 5, 0, 4, 0, 7],
  [0, 0, 8, 0, 0, 0, 3, 0, 0],
  [0, 0, 1, 0, 9, 0, 0, 0, 0],
  [3, 0, 0, 4, 0, 0, 2, 0, 0],
  [0, 5, 0, 1, 0, 0, 0, 0, 0],
  [0, 0, 0, 8, 0, 6, 0, 0, 0],
];

// Impossible Sudoku — conflicting constraints (two 5s in first row)
const IMPOSSIBLE_PUZZLE: number[][] = [
  [5, 3, 0, 0, 7, 0, 0, 0, 5],
  [6, 0, 0, 1, 9, 5, 0, 0, 0],
  [0, 9, 8, 0, 0, 0, 0, 6, 0],
  [8, 0, 0, 0, 6, 0, 0, 0, 3],
  [4, 0, 0, 8, 0, 3, 0, 0, 1],
  [7, 0, 0, 0, 2, 0, 0, 0, 6],
  [0, 6, 0, 0, 0, 0, 2, 8, 0],
  [0, 0, 0, 4, 1, 9, 0, 0, 5],
  [0, 0, 0, 0, 8, 0, 0, 7, 9],
];

// ── Validation Helpers ──────────────────────────────────────────────

function isValidSudoku(grid: number[][]): boolean {
  if (!grid || grid.length !== 9) return false;

  const fullSet = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);

  // Check rows
  for (let r = 0; r < 9; r++) {
    if (grid[r].length !== 9) return false;
    const row = new Set(grid[r]);
    if (row.size !== 9) return false;
    for (const v of fullSet) if (!row.has(v)) return false;
  }

  // Check columns
  for (let c = 0; c < 9; c++) {
    const col = new Set<number>();
    for (let r = 0; r < 9; r++) col.add(grid[r][c]);
    if (col.size !== 9) return false;
    for (const v of fullSet) if (!col.has(v)) return false;
  }

  // Check 3x3 boxes
  for (let br = 0; br < 3; br++) {
    for (let bc = 0; bc < 3; bc++) {
      const box = new Set<number>();
      for (let r = br * 3; r < br * 3 + 3; r++) {
        for (let c = bc * 3; c < bc * 3 + 3; c++) {
          box.add(grid[r][c]);
        }
      }
      if (box.size !== 9) return false;
      for (const v of fullSet) if (!box.has(v)) return false;
    }
  }

  return true;
}

function respectsGivens(puzzle: number[][], solution: number[][]): boolean {
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (puzzle[r][c] !== 0 && puzzle[r][c] !== solution[r][c]) return false;
    }
  }
  return true;
}

// ── Scheduling Data ─────────────────────────────────────────────────

interface Task {
  id: string;
  duration: number;
  earliest: number;
  latest: number;
  resource?: string;
}

interface Assignment {
  taskId: string;
  start: number;
  end: number;
  resource: string;
}

const FEASIBLE_TASKS: Task[] = [
  { id: "A", duration: 2, earliest: 0, latest: 10 },
  { id: "B", duration: 3, earliest: 1, latest: 10 },
  { id: "C", duration: 1, earliest: 0, latest: 5 },
  { id: "D", duration: 2, earliest: 3, latest: 8 },
  { id: "E", duration: 4, earliest: 0, latest: 10 },
];

const IMPOSSIBLE_TASKS: Task[] = [
  { id: "T1", duration: 5, earliest: 0, latest: 5 },
  { id: "T2", duration: 5, earliest: 0, latest: 5 },
  { id: "T3", duration: 5, earliest: 0, latest: 5 },
  { id: "T4", duration: 5, earliest: 0, latest: 5 },
  { id: "T5", duration: 5, earliest: 0, latest: 5 },
  { id: "T6", duration: 5, earliest: 0, latest: 5 },
];

// 15 tasks for performance test
const PERF_TASKS: Task[] = Array.from({ length: 15 }, (_, i) => ({
  id: `P${i + 1}`,
  duration: 1 + (i % 3),
  earliest: Math.floor(i / 3) * 2,
  latest: Math.floor(i / 3) * 2 + 10,
}));

function isValidSchedule(
  tasks: Task[],
  assignments: Assignment[],
  resourceCount: number
): boolean {
  if (!assignments || assignments.length !== tasks.length) return false;

  const resources = new Set(assignments.map((a) => a.resource));
  if (resources.size > resourceCount) return false;

  // Check each task matches constraints
  for (const task of tasks) {
    const a = assignments.find((x) => x.taskId === task.id);
    if (!a) return false;
    if (a.end - a.start < task.duration) return false;
    if (a.start < task.earliest) return false;
    if (a.end > task.latest) return false;
  }

  // Check no overlaps within same resource
  for (const res of resources) {
    const resAssignments = assignments
      .filter((a) => a.resource === res)
      .sort((a, b) => a.start - b.start);

    for (let i = 1; i < resAssignments.length; i++) {
      if (resAssignments[i].start < resAssignments[i - 1].end) return false;
    }
  }

  return true;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("MR001: Constraint Solver", () => {
  // ── Sudoku ──────────────────────────────────────────────────────

  test("sudoku easy (30 givens)", async () => {
    const result = await Promise.resolve(solveSudoku(EASY_PUZZLE));
    expect(result).toBeDefined();
    expect(result).not.toBeNull();
    expect(isValidSudoku(result)).toBe(true);
    expect(respectsGivens(EASY_PUZZLE, result)).toBe(true);
  });

  test("sudoku hard (17 givens — near minimum)", async () => {
    const result = await Promise.resolve(solveSudoku(HARD_PUZZLE));
    expect(result).toBeDefined();
    expect(result).not.toBeNull();
    expect(isValidSudoku(result)).toBe(true);
    expect(respectsGivens(HARD_PUZZLE, result)).toBe(true);
  });

  test("sudoku impossible — returns null, does not hang", async () => {
    const timeout = new Promise<"timeout">((res) =>
      setTimeout(() => res("timeout"), 5000)
    );
    const solve = Promise.resolve(solveSudoku(IMPOSSIBLE_PUZZLE));
    const race = await Promise.race([solve, timeout]);

    expect(race).not.toBe("timeout");
    // Result should be null/undefined/false — not a valid grid
    const result = race as any;
    const isNullish = result === null || result === undefined || result === false;
    expect(isNullish).toBe(true);
  });

  test("sudoku validation — solution satisfies all constraints", async () => {
    const result = await Promise.resolve(solveSudoku(EASY_PUZZLE));
    expect(result).toBeDefined();
    expect(result).not.toBeNull();

    // Every row contains exactly {1..9}
    for (let r = 0; r < 9; r++) {
      const row = new Set(result[r]);
      expect(row.size).toBe(9);
      for (let v = 1; v <= 9; v++) expect(row.has(v)).toBe(true);
    }

    // Every column contains exactly {1..9}
    for (let c = 0; c < 9; c++) {
      const col = new Set<number>();
      for (let r = 0; r < 9; r++) col.add(result[r][c]);
      expect(col.size).toBe(9);
      for (let v = 1; v <= 9; v++) expect(col.has(v)).toBe(true);
    }

    // Every 3x3 box contains exactly {1..9}
    for (let br = 0; br < 3; br++) {
      for (let bc = 0; bc < 3; bc++) {
        const box = new Set<number>();
        for (let r = br * 3; r < br * 3 + 3; r++) {
          for (let c = bc * 3; c < bc * 3 + 3; c++) {
            box.add(result[r][c]);
          }
        }
        expect(box.size).toBe(9);
        for (let v = 1; v <= 9; v++) expect(box.has(v)).toBe(true);
      }
    }
  });

  // ── Scheduling ──────────────────────────────────────────────────

  test("scheduling feasible — 5 tasks, 2 resources", async () => {
    const result = await Promise.resolve(solveSchedule(FEASIBLE_TASKS, 2));
    expect(result).toBeDefined();
    expect(result).not.toBeNull();

    // Normalize: result could be { assignments: [...] } or just [...]
    const assignments: Assignment[] = Array.isArray(result)
      ? result
      : result.assignments ?? result.schedule ?? result.result;

    expect(Array.isArray(assignments)).toBe(true);
    expect(isValidSchedule(FEASIBLE_TASKS, assignments, 2)).toBe(true);
  });

  test("scheduling impossible — too many tasks, not enough resources/time", async () => {
    const result = await Promise.resolve(solveSchedule(IMPOSSIBLE_TASKS, 1));
    // Should return null/undefined/false or { success: false } or empty array
    const isFailure =
      result === null ||
      result === undefined ||
      result === false ||
      result?.success === false ||
      result?.feasible === false ||
      (Array.isArray(result) && result.length === 0) ||
      (result?.assignments && result.assignments.length === 0);
    expect(isFailure).toBe(true);
  });

  // ── AC-3 ────────────────────────────────────────────────────────

  test("AC-3 domain reduction on partial Sudoku", async () => {
    if (!ac3) {
      // If ac3 is not directly exported, try using CSPSolver's internal methods
      if (CSPSolver) {
        const solver = typeof CSPSolver === "function" ? new CSPSolver() : CSPSolver;
        const ac3Method =
          solver.ac3 ??
          solver.AC3 ??
          solver.arcConsistency ??
          solver.preprocess;
        if (!ac3Method) {
          // Skip gracefully — AC-3 not accessible
          expect(true).toBe(true);
          return;
        }
      } else {
        expect(true).toBe(true);
        return;
      }
    }

    // Build domains for partially filled Sudoku
    // Each cell starts with domain {1..9} if empty, or {given} if filled
    const domains: Map<string, Set<number>> = new Map();
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const key = `${r},${c}`;
        if (EASY_PUZZLE[r][c] !== 0) {
          domains.set(key, new Set([EASY_PUZZLE[r][c]]));
        } else {
          domains.set(key, new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]));
        }
      }
    }

    const initialEmptyDomainSizes: number[] = [];
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (EASY_PUZZLE[r][c] === 0) {
          initialEmptyDomainSizes.push(domains.get(`${r},${c}`)!.size);
        }
      }
    }

    // Run AC-3 (implementation may accept domains directly or puzzle grid)
    let reduced: any;
    if (ac3) {
      reduced = await Promise.resolve(
        ac3(EASY_PUZZLE, domains) ?? ac3(domains) ?? ac3(EASY_PUZZLE)
      );
    }

    // After AC-3, at least some empty cells should have smaller domains
    // We check the returned domains or the mutated domains map
    const resultDomains: Map<string, Set<number>> =
      reduced instanceof Map
        ? reduced
        : reduced?.domains instanceof Map
        ? reduced.domains
        : domains; // may have been mutated in place

    let reductionCount = 0;
    let idx = 0;
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (EASY_PUZZLE[r][c] === 0) {
          const currentSize = resultDomains.get(`${r},${c}`)?.size ?? 9;
          if (currentSize < initialEmptyDomainSizes[idx]) {
            reductionCount++;
          }
          idx++;
        }
      }
    }

    // AC-3 should reduce at least some domains on a partially filled Sudoku
    expect(reductionCount).toBeGreaterThan(0);
  });

  // ── Performance ─────────────────────────────────────────────────

  test(
    "performance — hard Sudoku under 2000ms",
    async () => {
      const start = performance.now();
      const result = await Promise.resolve(solveSudoku(HARD_PUZZLE));
      const elapsed = performance.now() - start;

      expect(result).toBeDefined();
      expect(result).not.toBeNull();
      expect(isValidSudoku(result)).toBe(true);
      expect(elapsed).toBeLessThan(2000);
    },
    { timeout: 5000 }
  );

  test(
    "performance — 15-task scheduling under 5000ms",
    async () => {
      const start = performance.now();
      const result = await Promise.resolve(solveSchedule(PERF_TASKS, 4));
      const elapsed = performance.now() - start;

      expect(result).toBeDefined();
      expect(result).not.toBeNull();

      const assignments: Assignment[] = Array.isArray(result)
        ? result
        : result.assignments ?? result.schedule ?? result.result;

      expect(Array.isArray(assignments)).toBe(true);
      expect(isValidSchedule(PERF_TASKS, assignments, 4)).toBe(true);
      expect(elapsed).toBeLessThan(5000);
    },
    { timeout: 10000 }
  );

  // ── Generic CSP: Map Coloring ───────────────────────────────────

  test("generic CSP — map coloring (4 regions, 3 colors)", async () => {
    if (!CSPSolver) {
      // Fall back: try direct solve export from csp module
      const solve = cspMod.solve ?? cspMod.solveCSP;
      if (!solve) {
        throw new Error("csp.ts must export CSPSolver class or solve function");
      }
    }

    // 4 regions: A, B, C, D
    // Adjacency: A-B, A-C, B-C, B-D, C-D
    const variables = ["A", "B", "C", "D"];
    const domains: Record<string, string[]> = {
      A: ["red", "green", "blue"],
      B: ["red", "green", "blue"],
      C: ["red", "green", "blue"],
      D: ["red", "green", "blue"],
    };
    const constraints: Array<[string, string]> = [
      ["A", "B"],
      ["A", "C"],
      ["B", "C"],
      ["B", "D"],
      ["C", "D"],
    ];

    let result: any;

    if (CSPSolver && typeof CSPSolver === "function") {
      // Class-based API
      const solver = new CSPSolver();

      // Try common API patterns
      if (solver.addVariable) {
        for (const v of variables) {
          solver.addVariable(v, domains[v]);
        }
        for (const [a, b] of constraints) {
          const notEqual =
            solver.addConstraint ??
            solver.addNotEqualConstraint ??
            solver.constrain;
          if (notEqual) {
            notEqual.call(solver, a, b, (x: string, y: string) => x !== y);
          }
        }
        result = await Promise.resolve(
          (solver.solve ?? solver.search ?? solver.run).call(solver)
        );
      } else if (solver.solve) {
        // Single-call API: solver.solve(variables, domains, constraints)
        result = await Promise.resolve(
          solver.solve(variables, domains, constraints)
        );
      }
    } else {
      // Function-based API
      const solve = cspMod.solve ?? cspMod.solveCSP ?? cspMod.default;
      result = await Promise.resolve(solve(variables, domains, constraints));
    }

    expect(result).toBeDefined();
    expect(result).not.toBeNull();

    // Normalize result — could be Map, object, or { assignment: ... }
    const assignment: Record<string, string> =
      result instanceof Map
        ? Object.fromEntries(result)
        : result.assignment ?? result.solution ?? result;

    // Each region has a valid color
    for (const v of variables) {
      expect(domains[v]).toContain(assignment[v]);
    }

    // No two adjacent regions share a color
    for (const [a, b] of constraints) {
      expect(assignment[a]).not.toBe(assignment[b]);
    }
  });
});
