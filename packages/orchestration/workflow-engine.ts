/**
 * Workflow Engine - sequential/parallel steps, conditional branching,
 * per-step retry, and resume from failure.
 */

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface StepDef<T = unknown> {
  id: string;
  parallel?: string[];        // IDs of steps to run in parallel with this one
  retry?: number;             // max attempts (default 1)
  condition?: (state: WorkflowState) => boolean; // skip if false
  run: (state: WorkflowState) => Promise<T>;
}

export interface StepState {
  status: StepStatus;
  attempts: number;
  output?: unknown;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface WorkflowState {
  id: string;
  steps: Record<string, StepState>;
  outputs: Record<string, unknown>;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "done" | "failed" | "paused";
}

export interface WorkflowPersistence {
  save(state: WorkflowState): Promise<void>;
  load(id: string): Promise<WorkflowState | null>;
}

// In-memory persistence (swap for SQLite/file in production)
export class InMemoryPersistence implements WorkflowPersistence {
  private store = new Map<string, WorkflowState>();
  async save(state: WorkflowState) { this.store.set(state.id, structuredClone(state)); }
  async load(id: string) { return this.store.get(id) ?? null; }
}

export interface WorkflowOptions {
  persistence?: WorkflowPersistence;
  onStepChange?: (id: string, step: StepState) => void;
}

export class Workflow {
  private state: WorkflowState;
  private persistence: WorkflowPersistence;
  private onStepChange?: (id: string, step: StepState) => void;

  constructor(
    private id: string,
    private steps: StepDef[],
    options: WorkflowOptions = {}
  ) {
    this.persistence = options.persistence ?? new InMemoryPersistence();
    this.onStepChange = options.onStepChange;
    this.state = {
      id,
      steps: Object.fromEntries(steps.map(s => [s.id, { status: "pending", attempts: 0 }])),
      outputs: {},
      startedAt: Date.now(),
      status: "running",
    };
  }

  /** Resume from a previously saved state (e.g. after failure). */
  async resume(): Promise<void> {
    const saved = await this.persistence.load(this.id);
    if (saved) this.state = saved;
    this.state.status = "running";
    await this.run();
  }

  /** Execute the workflow from the current state. */
  async run(): Promise<WorkflowState> {
    const executed = new Set<string>();

    for (const def of this.steps) {
      if (executed.has(def.id)) continue;

      // Gather parallel group
      const group: StepDef[] = [def];
      if (def.parallel?.length) {
        for (const pid of def.parallel) {
          const pdef = this.steps.find(s => s.id === pid);
          if (pdef && !executed.has(pid)) group.push(pdef);
        }
      }

      await Promise.all(group.map(s => this.runStep(s)));
      group.forEach(s => executed.add(s.id));

      // Abort if any step failed and is not optional
      const anyFailed = group.some(s => this.state.steps[s.id].status === "failed");
      if (anyFailed) {
        this.state.status = "failed";
        await this.persistence.save(this.state);
        return this.state;
      }
    }

    this.state.status = "done";
    this.state.finishedAt = Date.now();
    await this.persistence.save(this.state);
    return this.state;
  }

  private async runStep(def: StepDef): Promise<void> {
    const step = this.state.steps[def.id];

    // Already completed in a previous run - skip
    if (step.status === "done" || step.status === "skipped") return;

    // Conditional gate
    if (def.condition && !def.condition(this.state)) {
      step.status = "skipped";
      this.emit(def.id, step);
      return;
    }

    const maxAttempts = def.retry ?? 1;
    step.status = "running";
    step.startedAt = Date.now();
    this.emit(def.id, step);

    while (step.attempts < maxAttempts) {
      step.attempts++;
      try {
        const output = await def.run(this.state);
        step.output = output;
        step.status = "done";
        step.finishedAt = Date.now();
        this.state.outputs[def.id] = output;
        this.emit(def.id, step);
        await this.persistence.save(this.state);
        return;
      } catch (err) {
        step.error = err instanceof Error ? err.message : String(err);
        if (step.attempts >= maxAttempts) {
          step.status = "failed";
          step.finishedAt = Date.now();
          this.emit(def.id, step);
          await this.persistence.save(this.state);
        }
      }
    }
  }

  private emit(id: string, step: StepState) {
    this.onStepChange?.(id, { ...step });
  }

  getState(): WorkflowState { return structuredClone(this.state); }
}
