/**
 * Session Export Utility
 *
 * Exports agent sessions to markdown, JSON, or HTML.
 * Includes conversation history, tool calls, files changed, and duration.
 */

export type ExportFormat = "markdown" | "json" | "html";

export interface ToolCall {
  name: string;
  args?: Record<string, unknown>;
  result?: string;
  durationMs?: number;
}

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  toolCalls?: ToolCall[];
}

export interface SessionData {
  id: string;
  model?: string;
  startedAt: string;
  endedAt?: string;
  messages: Message[];
  filesChanged?: string[];
  metadata?: Record<string, unknown>;
}

interface ExportOptions {
  format: ExportFormat;
  includeToolCalls?: boolean;
  includeFilesChanged?: boolean;
  includeMetadata?: boolean;
}

function durationStr(start: string, end?: string): string {
  if (!end) return "in progress";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

function toolCallSummary(calls: ToolCall[]): string {
  const counts: Record<string, number> = {};
  for (const c of calls) {
    counts[c.name] = (counts[c.name] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([name, count]) => `${name} (x${count})`)
    .join(", ");
}

// --- Markdown ---

function toMarkdown(session: SessionData, opts: ExportOptions): string {
  const lines: string[] = [];
  lines.push(`# Session ${session.id}`);
  lines.push("");
  lines.push(`- **Model:** ${session.model || "unknown"}`);
  lines.push(`- **Started:** ${session.startedAt}`);
  lines.push(`- **Duration:** ${durationStr(session.startedAt, session.endedAt)}`);
  lines.push(`- **Messages:** ${session.messages.length}`);

  const allToolCalls = session.messages.flatMap((m) => m.toolCalls || []);
  if (allToolCalls.length > 0) {
    lines.push(`- **Tool calls:** ${allToolCalls.length} - ${toolCallSummary(allToolCalls)}`);
  }

  if (opts.includeFilesChanged && session.filesChanged?.length) {
    lines.push("");
    lines.push("## Files Changed");
    lines.push("");
    for (const f of session.filesChanged) {
      lines.push(`- \`${f}\``);
    }
  }

  lines.push("");
  lines.push("## Conversation");
  lines.push("");

  for (const msg of session.messages) {
    const roleLabel = msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : "System";
    lines.push(`### ${roleLabel} - ${msg.timestamp}`);
    lines.push("");
    lines.push(msg.content);
    lines.push("");

    if (opts.includeToolCalls && msg.toolCalls?.length) {
      lines.push("**Tool calls:**");
      lines.push("");
      for (const tc of msg.toolCalls) {
        const dur = tc.durationMs ? ` (${tc.durationMs}ms)` : "";
        lines.push(`- \`${tc.name}\`${dur}`);
      }
      lines.push("");
    }
  }

  if (opts.includeMetadata && session.metadata) {
    lines.push("## Metadata");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(session.metadata, null, 2));
    lines.push("```");
  }

  return lines.join("\n");
}

// --- HTML ---

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function toHtml(session: SessionData, opts: ExportOptions): string {
  const msgs = session.messages
    .map((m) => {
      const role = escapeHtml(m.role);
      const content = escapeHtml(m.content);
      const tools =
        opts.includeToolCalls && m.toolCalls?.length
          ? `<ul>${m.toolCalls.map((tc) => `<li><code>${escapeHtml(tc.name)}</code></li>`).join("")}</ul>`
          : "";
      return `<div class="msg ${role}"><strong>${role}</strong> <time>${escapeHtml(m.timestamp)}</time><p>${content}</p>${tools}</div>`;
    })
    .join("\n");

  const files =
    opts.includeFilesChanged && session.filesChanged?.length
      ? `<h2>Files Changed</h2><ul>${session.filesChanged.map((f) => `<li><code>${escapeHtml(f)}</code></li>`).join("")}</ul>`
      : "";

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Session ${escapeHtml(session.id)}</title>
<style>body{font-family:Inter,system-ui,sans-serif;max-width:800px;margin:0 auto;padding:1rem;color:#e0e0e0;background:#111}
.msg{margin:1rem 0;padding:1rem;border-radius:8px;border:1px solid #333}
.user{background:#1a1a2e}.assistant{background:#162016}.system{background:#2a1a0a}
code{background:#222;padding:2px 6px;border-radius:4px;font-family:"JetBrains Mono",monospace}
time{color:#888;margin-left:0.5rem;font-size:0.85rem}h1,h2{color:#E8610A}</style>
</head><body><h1>Session ${escapeHtml(session.id)}</h1>
<p>Model: ${escapeHtml(session.model || "unknown")} - Duration: ${escapeHtml(durationStr(session.startedAt, session.endedAt))}</p>
${files}<h2>Conversation</h2>${msgs}</body></html>`;
}

// --- Public API ---

export function exportSession(session: SessionData, opts: ExportOptions): string {
  const resolvedOpts: ExportOptions = {
    includeToolCalls: true,
    includeFilesChanged: true,
    includeMetadata: true,
    ...opts,
  };

  switch (opts.format) {
    case "markdown":
      return toMarkdown(session, resolvedOpts);
    case "json":
      return JSON.stringify(session, null, 2);
    case "html":
      return toHtml(session, resolvedOpts);
    default:
      throw new Error(`Unsupported export format: ${opts.format}`);
  }
}

export async function exportSessionToFile(
  session: SessionData,
  outputPath: string,
  opts: ExportOptions,
): Promise<void> {
  const content = exportSession(session, opts);
  await Bun.write(outputPath, content);
}
