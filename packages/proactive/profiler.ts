/**
 * Performance Profiler for Eight Sessions
 *
 * Measures time spent in each phase (thinking, tool execution, streaming),
 * identifies bottlenecks, calculates throughput, and compares local vs cloud.
 * Self-contained - no modifications to existing files required.
 */

// -- Types --

export type Phase = "thinking" | "tool_execution" | "streaming" | "idle";

export interface PhaseSpan {
  phase: Phase;
  startMs: number;
  endMs: number;
  meta?: Record<string, unknown>;
}

export interface ToolSpan {
  name: string;
  startMs: number;
  endMs: number;
  success: boolean;
}

export interface StreamingSnapshot {
  tokensGenerated: number;
  durationMs: number;
  model: string;
  provider: "local" | "cloud";
}

export interface Bottleneck {
  type: "slow_tool" | "long_thinking" | "low_throughput";
  description: string;
  durationMs: number;
  recommendation: string;
}

export interface PerformanceReport {
  sessionId: string;
  totalDurationMs: number;
  phaseBreakdown: Record<Phase, { totalMs: number; count: number; avgMs: number }>;
  toolBreakdown: { name: string; totalMs: number; calls: number; avgMs: number; failures: number }[];
  throughput: { tokensPerSecond: number; totalTokens: number; totalStreamMs: number };
  modelComparison: { model: string; provider: "local" | "cloud"; tokensPerSecond: number; samples: number }[];
  bottlenecks: Bottleneck[];
  recommendations: string[];
}

// -- Profiler --

export class SessionProfiler {
  private sessionId: string;
  private startMs: number;
  private phases: PhaseSpan[] = [];
  private tools: ToolSpan[] = [];
  private streams: StreamingSnapshot[] = [];
  private currentPhase: { phase: Phase; startMs: number } | null = null;
  private currentTool: { name: string; startMs: number } | null = null;

  constructor(sessionId?: string) {
    this.sessionId = sessionId ?? `prof-${Date.now()}`;
    this.startMs = Date.now();
  }

  /** Start tracking a phase. Ends any active phase first. */
  beginPhase(phase: Phase, meta?: Record<string, unknown>): void {
    this.endPhase();
    this.currentPhase = { phase, startMs: Date.now() };
  }

  /** End the current phase. */
  endPhase(): void {
    if (!this.currentPhase) return;
    this.phases.push({
      phase: this.currentPhase.phase,
      startMs: this.currentPhase.startMs,
      endMs: Date.now(),
    });
    this.currentPhase = null;
  }

  /** Start tracking a tool call. */
  beginTool(name: string): void {
    this.currentTool = { name, startMs: Date.now() };
  }

  /** End the current tool call. */
  endTool(success = true): void {
    if (!this.currentTool) return;
    this.tools.push({
      name: this.currentTool.name,
      startMs: this.currentTool.startMs,
      endMs: Date.now(),
      success,
    });
    this.currentTool = null;
  }

  /** Record a streaming snapshot (call after each generation completes). */
  recordStream(snapshot: StreamingSnapshot): void {
    this.streams.push(snapshot);
  }

  /** Generate the full performance report. */
  report(): PerformanceReport {
    this.endPhase(); // close any open phase
    const now = Date.now();
    const totalDurationMs = now - this.startMs;

    // Phase breakdown
    const phaseBreakdown = this.buildPhaseBreakdown();

    // Tool breakdown
    const toolBreakdown = this.buildToolBreakdown();

    // Throughput
    const totalTokens = this.streams.reduce((s, x) => s + x.tokensGenerated, 0);
    const totalStreamMs = this.streams.reduce((s, x) => s + x.durationMs, 0);
    const tokensPerSecond = totalStreamMs > 0 ? (totalTokens / totalStreamMs) * 1000 : 0;

    // Model comparison
    const modelComparison = this.buildModelComparison();

    // Bottleneck detection
    const bottlenecks = this.detectBottlenecks(phaseBreakdown, toolBreakdown, tokensPerSecond);

    // Recommendations
    const recommendations = bottlenecks.map((b) => b.recommendation);
    if (totalDurationMs > 60_000 && phaseBreakdown.idle.totalMs > totalDurationMs * 0.3) {
      recommendations.push("Over 30% idle time - consider prefetching or pipelining phases.");
    }

    return {
      sessionId: this.sessionId,
      totalDurationMs,
      phaseBreakdown,
      toolBreakdown,
      throughput: { tokensPerSecond: round2(tokensPerSecond), totalTokens, totalStreamMs },
      modelComparison,
      bottlenecks,
      recommendations: [...new Set(recommendations)],
    };
  }

  /** Format report as human-readable text. */
  static formatReport(r: PerformanceReport): string {
    const lines: string[] = [];
    lines.push(`--- Performance Report: ${r.sessionId} ---`);
    lines.push(`Total duration: ${fmtMs(r.totalDurationMs)}`);
    lines.push("");
    lines.push("Phase Breakdown:");
    for (const phase of ["thinking", "tool_execution", "streaming", "idle"] as Phase[]) {
      const p = r.phaseBreakdown[phase];
      if (p.count === 0) continue;
      const pct = r.totalDurationMs > 0 ? round2((p.totalMs / r.totalDurationMs) * 100) : 0;
      lines.push(`  ${phase}: ${fmtMs(p.totalMs)} (${pct}%) - ${p.count} spans, avg ${fmtMs(p.avgMs)}`);
    }
    lines.push("");
    if (r.toolBreakdown.length > 0) {
      lines.push("Slowest Tools:");
      for (const t of r.toolBreakdown.slice(0, 5)) {
        lines.push(`  ${t.name}: ${fmtMs(t.avgMs)} avg, ${t.calls} calls, ${t.failures} failures`);
      }
      lines.push("");
    }
    lines.push(`Throughput: ${r.throughput.tokensPerSecond} tok/s (${r.throughput.totalTokens} tokens)`);
    lines.push("");
    if (r.modelComparison.length > 0) {
      lines.push("Model Comparison:");
      for (const m of r.modelComparison) {
        lines.push(`  ${m.model} (${m.provider}): ${m.tokensPerSecond} tok/s [${m.samples} samples]`);
      }
      lines.push("");
    }
    if (r.bottlenecks.length > 0) {
      lines.push("Bottlenecks:");
      for (const b of r.bottlenecks) {
        lines.push(`  [${b.type}] ${b.description} (${fmtMs(b.durationMs)})`);
      }
      lines.push("");
    }
    if (r.recommendations.length > 0) {
      lines.push("Recommendations:");
      for (const rec of r.recommendations) {
        lines.push(`  - ${rec}`);
      }
    }
    return lines.join("\n");
  }

  // -- Private helpers --

  private buildPhaseBreakdown(): Record<Phase, { totalMs: number; count: number; avgMs: number }> {
    const init = () => ({ totalMs: 0, count: 0, avgMs: 0 });
    const bd: Record<Phase, { totalMs: number; count: number; avgMs: number }> = {
      thinking: init(), tool_execution: init(), streaming: init(), idle: init(),
    };
    for (const span of this.phases) {
      const dur = span.endMs - span.startMs;
      bd[span.phase].totalMs += dur;
      bd[span.phase].count += 1;
    }
    for (const phase of Object.keys(bd) as Phase[]) {
      bd[phase].avgMs = bd[phase].count > 0 ? round2(bd[phase].totalMs / bd[phase].count) : 0;
    }
    return bd;
  }

  private buildToolBreakdown(): PerformanceReport["toolBreakdown"] {
    const map = new Map<string, { totalMs: number; calls: number; failures: number }>();
    for (const t of this.tools) {
      const entry = map.get(t.name) ?? { totalMs: 0, calls: 0, failures: 0 };
      entry.totalMs += t.endMs - t.startMs;
      entry.calls += 1;
      if (!t.success) entry.failures += 1;
      map.set(t.name, entry);
    }
    return [...map.entries()]
      .map(([name, v]) => ({ name, ...v, avgMs: round2(v.totalMs / v.calls) }))
      .sort((a, b) => b.avgMs - a.avgMs);
  }

  private buildModelComparison(): PerformanceReport["modelComparison"] {
    const map = new Map<string, { provider: "local" | "cloud"; totalTok: number; totalMs: number; samples: number }>();
    for (const s of this.streams) {
      const key = `${s.model}:${s.provider}`;
      const entry = map.get(key) ?? { provider: s.provider, totalTok: 0, totalMs: 0, samples: 0 };
      entry.totalTok += s.tokensGenerated;
      entry.totalMs += s.durationMs;
      entry.samples += 1;
      map.set(key, entry);
    }
    return [...map.entries()].map(([key, v]) => ({
      model: key.split(":")[0],
      provider: v.provider,
      tokensPerSecond: v.totalMs > 0 ? round2((v.totalTok / v.totalMs) * 1000) : 0,
      samples: v.samples,
    }));
  }

  private detectBottlenecks(
    phases: PerformanceReport["phaseBreakdown"],
    tools: PerformanceReport["toolBreakdown"],
    tps: number,
  ): Bottleneck[] {
    const out: Bottleneck[] = [];
    // Slow tools (avg > 5s)
    for (const t of tools) {
      if (t.avgMs > 5000) {
        out.push({
          type: "slow_tool",
          description: `${t.name} averages ${fmtMs(t.avgMs)} per call`,
          durationMs: t.totalMs,
          recommendation: `Optimize or cache ${t.name} - consider batching calls or reducing scope.`,
        });
      }
    }
    // Long thinking (any single span > 15s average)
    if (phases.thinking.avgMs > 15_000) {
      out.push({
        type: "long_thinking",
        description: `Average thinking time is ${fmtMs(phases.thinking.avgMs)}`,
        durationMs: phases.thinking.totalMs,
        recommendation: "Try a smaller/faster model for initial planning, or break prompts into shorter steps.",
      });
    }
    // Low throughput (< 10 tok/s with local, < 30 tok/s with cloud)
    if (tps > 0 && tps < 10) {
      out.push({
        type: "low_throughput",
        description: `Token throughput is ${round2(tps)} tok/s`,
        durationMs: phases.streaming.totalMs,
        recommendation: "Local model may be too large for hardware. Try a smaller quantization or switch to cloud.",
      });
    }
    return out;
  }
}

// -- Utility --

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${round2(ms / 1000)}s`;
  return `${round2(ms / 60_000)}min`;
}
