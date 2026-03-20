/**
 * @8gent/telegram-bot — Rich Message Formatters
 *
 * Professional monitoring dashboard formatting for Telegram.
 * Unicode box drawing, progress bars, sparklines, trend arrows.
 *
 * Design principles:
 * - Clean hierarchy: header -> key metric -> details -> footer
 * - Strategic emoji as visual anchors, not decoration
 * - Progress bars for scores (▓░)
 * - Trend arrows (↗↘→) for deltas
 * - Monospaced tables for alignment
 */

import type {
  BenchmarkScore,
  CompetitionRound,
  BenchmarkReport,
  OvernightSummary,
  TierBreakdown,
  SystemStatus,
  AlertSeverity,
} from "./types";

// ── Constants ───────────────────────────────────────────

const BAR_FULL = "▓";
const BAR_EMPTY = "░";
const BAR_LENGTH = 10;

const SEVERITY_ICON: Record<AlertSeverity, string> = {
  info: "ℹ️",
  warning: "⚠️",
  critical: "🚨",
};

const TIER_ICON: Record<string, string> = {
  basic: "🟢",
  intermediate: "🔵",
  advanced: "🟠",
  expert: "🔴",
};

// ── Helpers ─────────────────────────────────────────────

function progressBar(value: number, max: number = 100): string {
  const ratio = Math.max(0, Math.min(1, value / max));
  const filled = Math.round(ratio * BAR_LENGTH);
  const empty = BAR_LENGTH - filled;
  return BAR_FULL.repeat(filled) + BAR_EMPTY.repeat(empty);
}

function trendArrow(current: number, previous?: number): string {
  if (previous === undefined) return "  ";
  const delta = current - previous;
  if (delta > 2) return "↗️";
  if (delta < -2) return "↘️";
  return "→ ";
}

function trendDelta(current: number, previous?: number): string {
  if (previous === undefined) return "";
  const delta = current - previous;
  if (delta === 0) return " (=)";
  return delta > 0 ? ` (+${delta.toFixed(1)})` : ` (${delta.toFixed(1)})`;
}

function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const chars = "▁▂▃▄▅▆▇█";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values
    .map((v) => chars[Math.min(7, Math.floor(((v - min) / range) * 7))])
    .join("");
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

function padLeft(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : " ".repeat(len - str.length) + str;
}

function horizontalRule(): string {
  return "─".repeat(28);
}

function gradeEmoji(score: number): string {
  if (score >= 90) return "🏆";
  if (score >= 80) return "✅";
  if (score >= 60) return "🟡";
  if (score >= 40) return "🟠";
  return "❌";
}

function timeAgo(timestamp: string): string {
  const ms = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ── Formatters ──────────────────────────────────────────

/**
 * Format a scoreboard as a Unicode table with progress bars.
 *
 * Example output:
 * ```
 * ┌─────────────────────────────┐
 * │  📊 BENCHMARK SCOREBOARD   │
 * ├─────────────────────────────┤
 * │ reasoning    ▓▓▓▓▓▓▓░░░ 72 │
 * │ code-gen     ▓▓▓▓▓▓▓▓░░ 85 │
 * │ refactor     ▓▓▓▓▓░░░░░ 51 │
 * └─────────────────────────────┘
 * ```
 */
export function formatScoreboard(scores: Record<string, number>): string {
  const entries = Object.entries(scores).sort(([, a], [, b]) => b - a);
  if (entries.length === 0) return "_No scores available._";

  const avg =
    entries.reduce((sum, [, v]) => sum + v, 0) / entries.length;
  const passing = entries.filter(([, v]) => v >= 70).length;

  const lines: string[] = [];
  lines.push("┌──────────────────────────────┐");
  lines.push("│   📊 BENCHMARK SCOREBOARD    │");
  lines.push("├──────────────────────────────┤");

  for (const [id, score] of entries) {
    const icon = gradeEmoji(score);
    const name = padRight(id.slice(0, 12), 12);
    const bar = progressBar(score);
    const num = padLeft(String(Math.round(score)), 3);
    lines.push(`│${icon}${name} ${bar} ${num} │`);
  }

  lines.push("├──────────────────────────────┤");
  lines.push(`│ AVG: ${avg.toFixed(1)} │ PASS: ${passing}/${entries.length}     │`);
  lines.push("└──────────────────────────────┘");

  return "```\n" + lines.join("\n") + "\n```";
}

/**
 * Format a full competition round with rich detail.
 */
export function formatCompetitionRound(round: CompetitionRound): string {
  const overallTrend = trendArrow(round.avgScore, round.previousAvgScore);
  const delta = trendDelta(round.avgScore, round.previousAvgScore);

  const header = [
    `🏁 *ROUND ${round.roundNumber}*`,
    `${horizontalRule()}`,
    "",
    `🧠 Model: \`${round.model}\`${round.opponent ? ` vs \`${round.opponent}\`` : ""}`,
    `📈 Average: *${round.avgScore.toFixed(1)}*${delta} ${overallTrend}`,
    `✅ Passing: *${round.passing}/${round.total}*`,
    `⏱ Duration: ${formatDuration(round.duration.totalMs)}`,
  ];

  if (round.tokens) {
    header.push(`🔤 Tokens: ${formatTokens(round.tokens.total)} (${formatTokens(round.tokens.input)}↓ ${formatTokens(round.tokens.output)}↑)`);
  }

  // Score breakdown
  const scoreLines: string[] = ["", "```"];
  const sorted = [...round.scores].sort((a, b) => b.score - a.score);
  for (const s of sorted) {
    const icon = s.passing ? "✓" : "✗";
    const name = padRight(s.id.slice(0, 14), 14);
    const bar = progressBar(s.score, s.maxScore);
    const num = padLeft(String(Math.round(s.score)), 3);
    const trend = s.previousScore !== undefined
      ? trendDelta(s.score, s.previousScore)
      : "";
    scoreLines.push(`${icon} ${name} ${bar} ${num}${trend}`);
  }
  scoreLines.push("```");

  // Mutations
  const mutationSection = round.mutations.length > 0
    ? [
        "",
        `🧬 *Mutations Applied (${round.mutations.length}):*`,
        ...round.mutations.slice(0, 5).map((m, i) => `  ${i + 1}. ${m}`),
        ...(round.mutations.length > 5 ? [`  _...and ${round.mutations.length - 5} more_`] : []),
      ]
    : [];

  const footer = [
    "",
    `_${new Date(round.timestamp).toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} PST_`,
  ];

  return [...header, ...scoreLines, ...mutationSection, ...footer].join("\n");
}

/**
 * Format a comprehensive benchmark report.
 */
export function formatBenchmarkReport(report: BenchmarkReport): string {
  const trend = trendArrow(report.avgScore, report.previousAvgScore);
  const delta = trendDelta(report.avgScore, report.previousAvgScore);

  const sections: string[] = [];

  // Header
  sections.push(`📊 *8GENT BENCHMARK REPORT*`);
  sections.push(`${horizontalRule()}`);
  sections.push("");

  // Key metrics row
  sections.push("```");
  sections.push(`  Iteration: #${report.iteration}`);
  sections.push(`  Model:     ${report.model}`);
  sections.push(`  Average:   ${report.avgScore.toFixed(1)}${delta} ${trend}`);
  sections.push(`  Passing:   ${report.passing}/${report.total}`);
  if (report.totalTokens) {
    sections.push(`  Tokens:    ${formatTokens(report.totalTokens)}`);
  }
  if (report.totalDurationMs) {
    sections.push(`  Duration:  ${formatDuration(report.totalDurationMs)}`);
  }
  sections.push("```");

  // Top movers
  if (report.topImprovers.length > 0) {
    sections.push("");
    sections.push("📈 *Top Improvers:*");
    for (const { id, delta: d } of report.topImprovers.slice(0, 3)) {
      sections.push(`  ↗️ \`${id}\` +${d.toFixed(1)}`);
    }
  }

  if (report.topDecliners.length > 0) {
    sections.push("");
    sections.push("📉 *Declining:*");
    for (const { id, delta: d } of report.topDecliners.slice(0, 3)) {
      sections.push(`  ↘️ \`${id}\` ${d.toFixed(1)}`);
    }
  }

  // Full scoreboard
  const scoreEntries: Record<string, number> = {};
  for (const [id, score] of Object.entries(report.scores)) {
    scoreEntries[id] = score;
  }
  sections.push("");
  sections.push(formatScoreboard(scoreEntries));

  // Tier breakdown
  if (report.tierBreakdown.length > 0) {
    sections.push(formatTierBreakdown(report.tierBreakdown));
  }

  // Footer
  sections.push(`_${new Date(report.timestamp).toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} PST_`);

  return sections.join("\n");
}

/**
 * Format the morning brief — the message James wakes up to.
 */
export function formatMorningBrief(summary: OvernightSummary): string {
  const netEmoji = summary.netDelta > 0 ? "📈" : summary.netDelta < 0 ? "📉" : "➡️";
  const netSign = summary.netDelta > 0 ? "+" : "";
  const passedDelta = summary.passingAtEnd - summary.passingAtStart;
  const passedSign = passedDelta > 0 ? "+" : "";

  const sections: string[] = [];

  // Hero header
  sections.push("☀️ *GOOD MORNING, JAMES*");
  sections.push(`🤖 *8gent Overnight Report*`);
  sections.push(`${horizontalRule()}`);
  sections.push("");

  // Key metrics block
  sections.push("```");
  sections.push("┌────────────────────────────┐");
  sections.push(`│  🏁 Rounds:    ${padLeft(String(summary.totalRounds), 4)}          │`);
  sections.push(`│  ⏱  Duration:  ${padLeft(summary.totalDurationHours.toFixed(1) + "h", 5)}         │`);
  sections.push(`│  🧠 Model:     ${padRight(summary.model.slice(0, 12), 12)}   │`);
  sections.push("├────────────────────────────┤");
  sections.push(`│  📊 Start Avg: ${padLeft(summary.startingAvg.toFixed(1), 5)}         │`);
  sections.push(`│  📊 End Avg:   ${padLeft(summary.endingAvg.toFixed(1), 5)}         │`);
  sections.push(`│  ${netEmoji} Net Delta: ${padLeft(netSign + summary.netDelta.toFixed(1), 6)}        │`);
  sections.push("├────────────────────────────┤");
  sections.push(`│  ✅ Passing:   ${summary.passingAtEnd}/${summary.totalBenchmarks} (${passedSign}${passedDelta})     │`);
  sections.push(`│  🧬 Mutations: ${padLeft(String(summary.totalMutations), 4)}          │`);
  sections.push(`│  🔤 Tokens:    ${padLeft(formatTokens(summary.tokensUsed), 5)}         │`);
  if (summary.estimatedCost !== undefined) {
    sections.push(`│  💰 Est Cost:  $${summary.estimatedCost.toFixed(2)}         │`);
  }
  sections.push("└────────────────────────────┘");
  sections.push("```");

  // Best/worst rounds
  sections.push("");
  sections.push(`🏆 *Best Round:* #${summary.bestRound.round} (${summary.bestRound.score.toFixed(1)})`);
  sections.push(`💀 *Worst Round:* #${summary.worstRound.round} (${summary.worstRound.score.toFixed(1)})`);

  // Highlights
  if (summary.highlights.length > 0) {
    sections.push("");
    sections.push("⚡ *Highlights:*");
    for (const h of summary.highlights.slice(0, 5)) {
      sections.push(`  • ${h}`);
    }
  }

  // New mutations
  if (summary.newMutations.length > 0) {
    sections.push("");
    sections.push(`🧬 *New Mutations (${summary.newMutations.length}):*`);
    for (const [i, m] of summary.newMutations.slice(0, 8).entries()) {
      sections.push(`  ${i + 1}. ${m}`);
    }
    if (summary.newMutations.length > 8) {
      sections.push(`  _...and ${summary.newMutations.length - 8} more_`);
    }
  }

  // Footer
  sections.push("");
  sections.push(`${horizontalRule()}`);
  sections.push(`_${new Date(summary.startTime).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "long", month: "long", day: "numeric" })}_`);
  sections.push(`_Run: ${new Date(summary.startTime).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit" })} → ${new Date(summary.endTime).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit" })} PST_`);

  return sections.join("\n");
}

/**
 * Format per-tier visual breakdown.
 */
export function formatTierBreakdown(tiers: TierBreakdown[]): string {
  if (tiers.length === 0) return "";

  const lines: string[] = [];
  lines.push("");
  lines.push("📋 *Tier Breakdown:*");
  lines.push("```");

  for (const tier of tiers) {
    const icon = TIER_ICON[tier.tier] || "⚪";
    const tierName = padRight(tier.tier.toUpperCase(), 14);
    const bar = progressBar(tier.avgScore);
    const stats = `${tier.passing}/${tier.total} pass`;

    lines.push(`${icon} ${tierName} ${bar} ${tier.avgScore.toFixed(0)} (${stats})`);

    // Individual scores within tier
    for (const s of tier.scores.slice(0, 5)) {
      const sIcon = s.passing ? "  ✓" : "  ✗";
      const sName = padRight(s.id.slice(0, 16), 16);
      const sBar = progressBar(s.score);
      lines.push(`${sIcon} ${sName} ${sBar} ${s.score.toFixed(0)}`);
    }
    if (tier.scores.length > 5) {
      lines.push(`    ...+${tier.scores.length - 5} more`);
    }
    lines.push("");
  }

  lines.push("```");
  return lines.join("\n");
}

/**
 * Format a numbered mutation list.
 */
export function formatMutationList(mutations: string[]): string {
  if (mutations.length === 0) {
    return "🧬 *Mutations*\n\n_No mutations accumulated yet._";
  }

  const lines: string[] = [];
  lines.push(`🧬 *Accumulated Mutations (${mutations.length})*`);
  lines.push(`${horizontalRule()}`);
  lines.push("");

  for (const [i, m] of mutations.entries()) {
    lines.push(`\`${padLeft(String(i + 1), 2)}.\` ${m}`);
  }

  return lines.join("\n");
}

/**
 * Format an alert message with severity styling.
 */
export function formatAlert(message: string, severity: AlertSeverity): string {
  const icon = SEVERITY_ICON[severity];
  const label = severity.toUpperCase();
  const border = severity === "critical" ? "🔴" : severity === "warning" ? "🟡" : "🔵";

  const lines = [
    `${border}${border}${border} ${icon} *${label}* ${icon} ${border}${border}${border}`,
    "",
    message,
    "",
    `_${new Date().toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit" })} PST_`,
  ];

  return lines.join("\n");
}

/**
 * Format system status panel.
 */
export function formatSystemStatus(status: SystemStatus): string {
  const statusIcon = status.online ? "🟢" : "🔴";
  const runIcon = status.isRunning ? "▶️" : "⏸";

  const lines: string[] = [];
  lines.push(`${statusIcon} *8GENT STATUS*`);
  lines.push(`${horizontalRule()}`);
  lines.push("");
  lines.push("```");
  lines.push(`  Status:     ${status.online ? "Online" : "Offline"}`);
  lines.push(`  Model:      ${status.model}`);
  lines.push(`  Loop:       ${status.isRunning ? "Running" : "Stopped"} ${runIcon}`);
  lines.push(`  Iteration:  #${status.currentIteration}`);
  lines.push(`  Uptime:     ${formatDuration(status.uptime)}`);
  lines.push(`  Last:       ${timeAgo(status.lastActivity)}`);
  lines.push("```");
  lines.push("");
  lines.push(`📊 Benchmarks: *${status.benchmarksPassing}/${status.benchmarksTotal}* passing`);
  lines.push(`📈 Avg Score: *${status.avgScore.toFixed(1)}*`);
  lines.push(`🧬 Mutations: *${status.mutationCount}*`);

  if (status.routerState) {
    lines.push(`🔀 Router: \`${status.routerState}\``);
  }

  return lines.join("\n");
}

/**
 * Format a comparison table (8gent vs Claude).
 */
export function formatComparison(
  eightScores: Record<string, number>,
  claudeScores: Record<string, number>
): string {
  const allKeys = [...new Set([...Object.keys(eightScores), ...Object.keys(claudeScores)])].sort();

  const lines: string[] = [];
  lines.push("⚔️ *8GENT vs CLAUDE*");
  lines.push(`${horizontalRule()}`);
  lines.push("");
  lines.push("```");
  lines.push(`${padRight("Benchmark", 16)} 8gent Claude  Δ`);
  lines.push("─".repeat(38));

  let eightTotal = 0;
  let claudeTotal = 0;
  let count = 0;

  for (const key of allKeys) {
    const e = eightScores[key] ?? 0;
    const c = claudeScores[key] ?? 0;
    const delta = e - c;
    const deltaStr = delta > 0 ? `+${delta.toFixed(0)}` : delta < 0 ? `${delta.toFixed(0)}` : " =";
    const winner = delta > 0 ? "🟢" : delta < 0 ? "🔴" : "⚪";

    lines.push(
      `${padRight(key.slice(0, 14), 16)} ${padLeft(e.toFixed(0), 5)} ${padLeft(c.toFixed(0), 5)} ${padLeft(deltaStr, 4)} ${winner}`
    );

    eightTotal += e;
    claudeTotal += c;
    count++;
  }

  lines.push("─".repeat(38));
  const eightAvg = count > 0 ? eightTotal / count : 0;
  const claudeAvg = count > 0 ? claudeTotal / count : 0;
  const avgDelta = eightAvg - claudeAvg;
  const avgDeltaStr = avgDelta > 0 ? `+${avgDelta.toFixed(1)}` : avgDelta.toFixed(1);

  lines.push(
    `${padRight("AVERAGE", 16)} ${padLeft(eightAvg.toFixed(1), 5)} ${padLeft(claudeAvg.toFixed(1), 5)} ${padLeft(avgDeltaStr, 4)}`
  );
  lines.push("```");

  // Verdict
  lines.push("");
  if (avgDelta > 5) {
    lines.push("🏆 *8gent leads by a significant margin.*");
  } else if (avgDelta > 0) {
    lines.push("📈 *8gent has a slight edge.*");
  } else if (avgDelta > -5) {
    lines.push("⚔️ *Neck and neck — keep pushing.*");
  } else {
    lines.push("🎯 *Claude leads — more mutations needed.*");
  }

  return lines.join("\n");
}

// ── Export sparkline helper for external use ─────────

export { sparkline, formatDuration, formatTokens, progressBar, trendArrow };
