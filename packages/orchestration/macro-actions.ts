/**
 * 8gent Code - Macro Action Decomposer
 *
 * Inspired by Karpathy: "you can move in much larger macro actions.
 * It's not just here's a line of code, here's a new function.
 * It's like here's a new functionality and delegate it to agent one."
 *
 * Decomposes user requests into coarse-grained, delegatable macro actions
 * that can run in parallel across worktrees.
 */

// ============================================
// Types
// ============================================

export interface MacroAction {
  id: string;
  title: string;
  type: "code" | "research" | "test" | "deploy" | "review";
  scope: string[];
  dependencies: string[];
  estimatedMinutes: number;
  delegatable: boolean;
  prompt: string;
}

export interface MacroActionPlan {
  actions: MacroAction[];
  parallelGroups: string[][];
  criticalPath: string[];
  estimatedTotalMinutes: number;
}

export interface DecomposeContext {
  files: string[];
  recentChanges: string[];
}

export interface PlanEstimate {
  totalSequential: number;
  totalParallel: number;
  speedup: number;
}

// ============================================
// Decompose
// ============================================

let _idCounter = 0;

function generateId(prefix: string): string {
  _idCounter++;
  return `${prefix}-${Date.now().toString(36)}-${_idCounter}`;
}

/**
 * Build the structured decomposition prompt template for Eight's agent loop.
 *
 * This is a TEMPLATE function — it doesn't call an LLM itself. It produces
 * a MacroActionPlan with a single placeholder action whose `prompt` field
 * contains the full instruction that Eight should send to the planner model.
 * Eight's agent loop fills in the real actions after the LLM responds.
 */
export function decompose(
  userRequest: string,
  context: DecomposeContext
): MacroActionPlan {
  const fileList = context.files.length > 0
    ? context.files.map(f => `  - ${f}`).join("\n")
    : "  (none provided)";

  const changeList = context.recentChanges.length > 0
    ? context.recentChanges.map(c => `  - ${c}`).join("\n")
    : "  (none)";

  const decompositionPrompt = `You are a macro-action planner for a coding agent system.

Given a user request, decompose it into coarse-grained MACRO ACTIONS — not individual lines or functions, but whole functionalities that can be delegated to independent sub-agents running in parallel worktrees.

## User Request
${userRequest}

## Repository Context
Files in scope:
${fileList}

Recent changes:
${changeList}

## Output Format
Return a JSON array of macro actions. Each action:
{
  "id": "ma-<short-slug>",
  "title": "<human-readable, e.g. 'Build auth middleware'>",
  "type": "code" | "research" | "test" | "deploy" | "review",
  "scope": ["<files or packages this action touches>"],
  "dependencies": ["<ids of actions that must complete first>"],
  "estimatedMinutes": <number>,
  "delegatable": <true if can run in parallel without interference>,
  "prompt": "<full instruction for the sub-agent, including context and acceptance criteria>"
}

## Rules
1. Each action should represent 10-60 minutes of focused agent work
2. Minimize dependencies — prefer independent actions that can parallelize
3. If two actions touch the same files, they CANNOT be delegatable (set delegatable: false) or one must depend on the other
4. Include a "review" action at the end that depends on all code/test actions
5. The prompt field must be self-contained — the sub-agent has no other context
6. Keep it to 2-8 actions. If the request is simple, 2-3 is fine.`;

  // Create the template plan with a single placeholder action
  const plannerAction: MacroAction = {
    id: generateId("ma"),
    title: "Decompose request into macro actions",
    type: "research",
    scope: [],
    dependencies: [],
    estimatedMinutes: 1,
    delegatable: false,
    prompt: decompositionPrompt,
  };

  return {
    actions: [plannerAction],
    parallelGroups: [[plannerAction.id]],
    criticalPath: [plannerAction.id],
    estimatedTotalMinutes: 1,
  };
}

// ============================================
// Parallel Group Discovery (Topological Sort)
// ============================================

/**
 * Find groups of actions that can execute simultaneously.
 * Uses Kahn's algorithm for topological ordering, then groups
 * actions by their "depth" in the dependency graph.
 */
export function findParallelGroups(actions: MacroAction[]): string[][] {
  if (actions.length === 0) return [];

  const actionMap = new Map<string, MacroAction>();
  for (const a of actions) actionMap.set(a.id, a);

  // Build in-degree map and adjacency list
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const a of actions) {
    inDegree.set(a.id, 0);
    dependents.set(a.id, []);
  }

  for (const a of actions) {
    let deg = 0;
    for (const depId of a.dependencies) {
      if (actionMap.has(depId)) {
        deg++;
        dependents.get(depId)!.push(a.id);
      }
    }
    inDegree.set(a.id, deg);
  }

  // Kahn's algorithm, collecting by wave/level
  const groups: string[][] = [];
  let currentWave: string[] = [];

  for (const a of actions) {
    if (inDegree.get(a.id) === 0) currentWave.push(a.id);
  }

  const visited = new Set<string>();

  while (currentWave.length > 0) {
    // Filter to only delegatable actions for true parallel execution,
    // but still include non-delegatable ones in their own slots
    groups.push([...currentWave]);

    const nextWave: string[] = [];
    for (const id of currentWave) {
      visited.add(id);
      for (const depId of dependents.get(id) || []) {
        const newDeg = inDegree.get(depId)! - 1;
        inDegree.set(depId, newDeg);
        if (newDeg === 0) {
          nextWave.push(depId);
        }
      }
    }
    currentWave = nextWave;
  }

  // Detect cycles: any unvisited nodes form a cycle
  if (visited.size < actions.length) {
    const cycled = actions
      .filter(a => !visited.has(a.id))
      .map(a => a.id);
    // Append cycled actions as a final sequential group
    groups.push(cycled);
  }

  return groups;
}

// ============================================
// Critical Path
// ============================================

/**
 * Find the critical path — the longest dependency chain by estimated time.
 * Returns action IDs in execution order.
 */
export function findCriticalPath(actions: MacroAction[]): string[] {
  if (actions.length === 0) return [];

  const actionMap = new Map<string, MacroAction>();
  for (const a of actions) actionMap.set(a.id, a);

  // Longest path via dynamic programming on topological order
  const groups = findParallelGroups(actions);
  const flat = groups.flat();

  // dist[id] = longest time to complete this action (including it)
  const dist = new Map<string, number>();
  // prev[id] = predecessor on critical path
  const prev = new Map<string, string | null>();

  for (const id of flat) {
    const action = actionMap.get(id)!;
    let maxPredDist = 0;
    let maxPred: string | null = null;

    for (const depId of action.dependencies) {
      const d = dist.get(depId) ?? 0;
      if (d > maxPredDist) {
        maxPredDist = d;
        maxPred = depId;
      }
    }

    dist.set(id, maxPredDist + action.estimatedMinutes);
    prev.set(id, maxPred);
  }

  // Find the node with max dist
  let maxDist = 0;
  let endNode = flat[0];
  for (const id of flat) {
    const d = dist.get(id) ?? 0;
    if (d > maxDist) {
      maxDist = d;
      endNode = id;
    }
  }

  // Trace back
  const path: string[] = [];
  let cur: string | null = endNode;
  while (cur !== null) {
    path.unshift(cur);
    cur = prev.get(cur) ?? null;
  }

  return path;
}

// ============================================
// Plan Estimation
// ============================================

/**
 * Calculate time saved by parallelization.
 */
export function estimatePlan(plan: MacroActionPlan): PlanEstimate {
  const actionMap = new Map<string, MacroAction>();
  for (const a of plan.actions) actionMap.set(a.id, a);

  // Sequential: sum of all action times
  const totalSequential = plan.actions.reduce(
    (sum, a) => sum + a.estimatedMinutes,
    0
  );

  // Parallel: sum of max-per-group
  let totalParallel = 0;
  for (const group of plan.parallelGroups) {
    let groupMax = 0;
    for (const id of group) {
      const action = actionMap.get(id);
      if (action && action.estimatedMinutes > groupMax) {
        groupMax = action.estimatedMinutes;
      }
    }
    totalParallel += groupMax;
  }

  // Guard against division by zero
  const speedup = totalParallel > 0 ? totalSequential / totalParallel : 1;

  return {
    totalSequential,
    totalParallel,
    speedup: Math.round(speedup * 100) / 100,
  };
}

// ============================================
// Plan Builder (convenience)
// ============================================

/**
 * Build a complete MacroActionPlan from a list of actions.
 * Automatically computes parallelGroups, criticalPath, and estimate.
 */
export function buildPlan(actions: MacroAction[]): MacroActionPlan {
  const parallelGroups = findParallelGroups(actions);
  const criticalPath = findCriticalPath(actions);
  const plan: MacroActionPlan = {
    actions,
    parallelGroups,
    criticalPath,
    estimatedTotalMinutes: 0,
  };
  const estimate = estimatePlan(plan);
  plan.estimatedTotalMinutes = estimate.totalParallel;
  return plan;
}

/**
 * Create a MacroAction with defaults.
 */
export function createAction(
  partial: Pick<MacroAction, "title" | "type" | "prompt"> &
    Partial<Omit<MacroAction, "title" | "type" | "prompt">>
): MacroAction {
  return {
    id: partial.id ?? generateId("ma"),
    title: partial.title,
    type: partial.type,
    scope: partial.scope ?? [],
    dependencies: partial.dependencies ?? [],
    estimatedMinutes: partial.estimatedMinutes ?? 15,
    delegatable: partial.delegatable ?? true,
    prompt: partial.prompt,
  };
}

/**
 * Format a plan for display in the terminal.
 */
export function formatPlan(plan: MacroActionPlan): string {
  const estimate = estimatePlan(plan);
  const lines: string[] = [
    `\x1b[1mMacro Action Plan\x1b[0m (${plan.actions.length} actions)`,
    `Sequential: ${estimate.totalSequential}min | Parallel: ${estimate.totalParallel}min | Speedup: ${estimate.speedup}x`,
    "",
  ];

  for (let i = 0; i < plan.parallelGroups.length; i++) {
    const group = plan.parallelGroups[i];
    lines.push(`\x1b[36mGroup ${i + 1}\x1b[0m (${group.length} parallel):`);
    for (const id of group) {
      const action = plan.actions.find(a => a.id === id);
      if (!action) continue;
      const depStr = action.dependencies.length > 0
        ? ` \x1b[90m(after: ${action.dependencies.join(", ")})\x1b[0m`
        : "";
      const typeColor =
        action.type === "code" ? "\x1b[33m" :
        action.type === "test" ? "\x1b[32m" :
        action.type === "research" ? "\x1b[35m" :
        action.type === "review" ? "\x1b[34m" :
        "\x1b[31m"; // deploy
      lines.push(
        `  ${typeColor}[${action.type}]\x1b[0m ${action.title} (~${action.estimatedMinutes}min)${depStr}`
      );
    }
  }

  lines.push("");
  lines.push(
    `\x1b[90mCritical path: ${plan.criticalPath.join(" -> ")}\x1b[0m`
  );

  return lines.join("\n");
}
