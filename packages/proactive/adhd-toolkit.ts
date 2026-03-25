/**
 * ADHD Toolkit - Focus tools for neurodivergent users
 *
 * Provides pomodoro timer, task breakdown, distraction detection,
 * celebration triggers, and progress visualization.
 */

// --- Types ---

export interface FocusTimerConfig {
  workMinutes: number;
  breakMinutes: number;
  longBreakMinutes: number;
  sessionsBeforeLongBreak: number;
}

export interface Chunk {
  id: number;
  label: string;
  estimatedMinutes: number;
  completed: boolean;
  completedAt?: number;
}

export interface ProgressSnapshot {
  total: number;
  done: number;
  remaining: number;
  percentComplete: number;
  elapsedMinutes: number;
  bar: string;
}

type TimerCallback = (event: "work-end" | "break-end" | "long-break-end" | "tick", remaining: number) => void;

// --- Focus Timer ---

const DEFAULT_CONFIG: FocusTimerConfig = {
  workMinutes: 25,
  breakMinutes: 5,
  longBreakMinutes: 15,
  sessionsBeforeLongBreak: 4,
};

export class FocusTimer {
  private config: FocusTimerConfig;
  private sessionsCompleted = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private remaining = 0;
  private phase: "idle" | "work" | "break" | "long-break" = "idle";
  private cb: TimerCallback | null = null;

  constructor(config: Partial<FocusTimerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get currentPhase() { return this.phase; }
  get secondsLeft() { return this.remaining; }
  get completed() { return this.sessionsCompleted; }

  start(callback: TimerCallback) {
    this.cb = callback;
    this.beginWork();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.phase = "idle";
  }

  private beginWork() {
    this.phase = "work";
    this.remaining = this.config.workMinutes * 60;
    this.runCountdown("work-end");
  }

  private beginBreak() {
    const isLong = this.sessionsCompleted % this.config.sessionsBeforeLongBreak === 0;
    this.phase = isLong ? "long-break" : "break";
    this.remaining = (isLong ? this.config.longBreakMinutes : this.config.breakMinutes) * 60;
    this.runCountdown(isLong ? "long-break-end" : "break-end");
  }

  private runCountdown(endEvent: "work-end" | "break-end" | "long-break-end") {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.remaining -= 1;
      this.cb?.("tick", this.remaining);
      if (this.remaining <= 0) {
        if (this.timer) clearInterval(this.timer);
        if (endEvent === "work-end") this.sessionsCompleted += 1;
        this.cb?.(endEvent, 0);
        if (endEvent === "work-end") this.beginBreak();
        else this.beginWork();
      }
    }, 1000);
  }
}

// --- Task Breakdown ---

export function breakdownTask(description: string, totalMinutes: number, chunkMinutes = 5): Chunk[] {
  const count = Math.max(1, Math.ceil(totalMinutes / chunkMinutes));
  const chunks: Chunk[] = [];
  for (let i = 0; i < count; i++) {
    chunks.push({
      id: i + 1,
      label: `${description} - part ${i + 1}/${count}`,
      estimatedMinutes: i < count - 1 ? chunkMinutes : totalMinutes - chunkMinutes * (count - 1) || chunkMinutes,
      completed: false,
    });
  }
  return chunks;
}

export function completeChunk(chunks: Chunk[], id: number): Chunk[] {
  return chunks.map((c) => (c.id === id ? { ...c, completed: true, completedAt: Date.now() } : c));
}

// --- Distraction Blocker ---

export class DistractionBlocker {
  private switches: number[] = [];
  private threshold: number;
  private windowMs: number;

  constructor(threshold = 5, windowMinutes = 10) {
    this.threshold = threshold;
    this.windowMs = windowMinutes * 60_000;
  }

  logSwitch() {
    const now = Date.now();
    this.switches.push(now);
    this.switches = this.switches.filter((t) => now - t < this.windowMs);
  }

  get recentSwitches() { return this.switches.length; }

  isDistracted(): boolean {
    return this.switches.length >= this.threshold;
  }

  warning(): string | null {
    if (!this.isDistracted()) return null;
    return `You have switched context ${this.switches.length} times in the last ${this.windowMs / 60_000} minutes. Try finishing the current chunk first.`;
  }
}

// --- Celebration Triggers ---

export type CelebrationKind = "confetti" | "sound" | "message";

export function celebration(chunksCompleted: number, total: number): { kind: CelebrationKind; text: string }[] {
  const results: { kind: CelebrationKind; text: string }[] = [];
  if (chunksCompleted === total) {
    results.push({ kind: "confetti", text: "All chunks done! You crushed it." });
    results.push({ kind: "sound", text: "victory" });
  } else if (chunksCompleted > 0 && chunksCompleted % 3 === 0) {
    results.push({ kind: "message", text: `${chunksCompleted}/${total} chunks done - solid streak.` });
    results.push({ kind: "sound", text: "ding" });
  } else if (chunksCompleted === 1) {
    results.push({ kind: "message", text: "First chunk done. Momentum started." });
  }
  return results;
}

// --- Progress Visualization ---

export function progressSnapshot(chunks: Chunk[], startedAt: number): ProgressSnapshot {
  const done = chunks.filter((c) => c.completed).length;
  const total = chunks.length;
  const remaining = total - done;
  const percentComplete = total > 0 ? Math.round((done / total) * 100) : 0;
  const elapsedMinutes = Math.round((Date.now() - startedAt) / 60_000);
  const barWidth = 20;
  const filled = Math.round((done / Math.max(total, 1)) * barWidth);
  const bar = "[" + "#".repeat(filled) + "-".repeat(barWidth - filled) + "]";
  return { total, done, remaining, percentComplete, elapsedMinutes, bar };
}
