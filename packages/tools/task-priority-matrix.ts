/**
 * TaskMatrix - Eisenhower priority matrix for task categorization.
 *
 * Quadrants:
 *   do       - urgent + important
 *   schedule - not urgent + important
 *   delegate - urgent + not important
 *   eliminate - not urgent + not important
 */

export type Quadrant = "do" | "schedule" | "delegate" | "eliminate";

export interface Task {
  name: string;
  urgency: number;    // 1-10, higher = more urgent
  importance: number; // 1-10, higher = more important
  quadrant: Quadrant;
  score: number;
}

export interface MatrixSummary {
  do: Task[];
  schedule: Task[];
  delegate: Task[];
  eliminate: Task[];
}

function resolveQuadrant(urgency: number, importance: number): Quadrant {
  const urgent = urgency >= 5;
  const important = importance >= 5;

  if (urgent && important) return "do";
  if (!urgent && important) return "schedule";
  if (urgent && !important) return "delegate";
  return "eliminate";
}

function computeScore(urgency: number, importance: number): number {
  // Importance weighted slightly higher than urgency (Eisenhower intent)
  return importance * 0.6 + urgency * 0.4;
}

function validateRange(value: number, field: string): void {
  if (value < 1 || value > 10) {
    throw new RangeError(`${field} must be between 1 and 10, got ${value}`);
  }
}

export class TaskMatrix {
  private tasks: Map<string, Task> = new Map();

  addTask(name: string, urgency: number, importance: number): this {
    validateRange(urgency, "urgency");
    validateRange(importance, "importance");

    const quadrant = resolveQuadrant(urgency, importance);
    const score = computeScore(urgency, importance);

    this.tasks.set(name, { name, urgency, importance, quadrant, score });
    return this;
  }

  removeTask(name: string): boolean {
    return this.tasks.delete(name);
  }

  getQuadrant(name: string): Quadrant | null {
    return this.tasks.get(name)?.quadrant ?? null;
  }

  categorize(): MatrixSummary {
    const result: MatrixSummary = {
      do: [],
      schedule: [],
      delegate: [],
      eliminate: [],
    };

    for (const task of this.tasks.values()) {
      result[task.quadrant].push(task);
    }

    // Sort each quadrant by score descending
    for (const q of Object.keys(result) as Quadrant[]) {
      result[q].sort((a, b) => b.score - a.score);
    }

    return result;
  }

  sortByPriority(): Task[] {
    const quadrantOrder: Record<Quadrant, number> = {
      do: 0,
      schedule: 1,
      delegate: 2,
      eliminate: 3,
    };

    return Array.from(this.tasks.values()).sort((a, b) => {
      const qDiff = quadrantOrder[a.quadrant] - quadrantOrder[b.quadrant];
      if (qDiff !== 0) return qDiff;
      return b.score - a.score;
    });
  }

  count(): number {
    return this.tasks.size;
  }

  clear(): void {
    this.tasks.clear();
  }

  toJSON(): MatrixSummary {
    return this.categorize();
  }
}
