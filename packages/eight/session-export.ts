/**
 * Session Export - Self-contained HTML export of chat sessions
 *
 * Generates a production-quality, mobile-responsive HTML page
 * with 8gent branding, syntax highlighting, and collapsible tool calls.
 */

import * as fs from "fs";
import * as path from "path";

export interface ExportMessage {
  role: string;
  content: string;
  timestamp: Date;
}

export interface ExportMetadata {
  sessionId: string;
  model: string;
  duration: string;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatContent(content: string): string {
  // Replace code blocks with styled <pre>
  let html = escapeHtml(content);
  html = html.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_m, _lang, code) =>
      `<details class="tool-call" open><summary>Code block</summary><pre class="code-block">${code.trim()}</pre></details>`
  );
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  // Tool call patterns: lines starting with "Tool:" or similar
  html = html.replace(
    /^(Tool|Calling|Executing|Running):?\s+(.+)$/gm,
    '<details class="tool-call"><summary>$1: $2</summary></details>'
  );
  // Newlines to <br>
  html = html.replace(/\n/g, "<br>");
  return html;
}

export async function exportSession(
  messages: ExportMessage[],
  metadata: ExportMetadata
): Promise<string> {
  const date = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const msgCount = messages.filter((m) => m.role !== "system").length;

  const messageHtml = messages
    .map((msg) => {
      const roleClass = msg.role === "user" ? "user" : msg.role === "assistant" ? "assistant" : "system";
      const time = msg.timestamp instanceof Date
        ? msg.timestamp.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
        : "";
      return `<div class="msg ${roleClass}"><span class="meta">${msg.role} ${time}</span><div class="body">${formatContent(msg.content)}</div></div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>8gent Code Session - ${escapeHtml(metadata.sessionId)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--orange:#E8610A;--bg:#0d1117;--surface:#161b22;--border:#30363d;--text:#e6edf3;--muted:#8b949e;--user-border:#e3b341;--asst-border:#58a6ff;--code-bg:#1c2128;--code-text:#7ee787}
body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;font-size:clamp(14px,1.6vw,16px);line-height:1.6}
.wrap{max-width:800px;margin:0 auto;padding:clamp(16px,4vw,32px)}
header{border-bottom:2px solid var(--orange);padding-bottom:clamp(12px,2vw,20px);margin-bottom:clamp(16px,3vw,28px)}
header h1{font-size:clamp(18px,3vw,28px);font-weight:600;color:var(--orange)}
header .sub{color:var(--muted);font-size:clamp(12px,1.4vw,14px);margin-top:4px;display:flex;flex-wrap:wrap;gap:clamp(8px,2vw,16px)}
header .sub span{white-space:nowrap}
.msg{padding:clamp(10px,2vw,14px) clamp(12px,2.5vw,16px);margin-bottom:clamp(8px,1.5vw,12px);border-radius:8px;background:var(--surface);border-left:3px solid var(--border);animation:fadeIn .3s ease}
.msg.user{border-left-color:var(--user-border);margin-left:clamp(16px,8vw,80px)}
.msg.assistant{border-left-color:var(--asst-border);margin-right:clamp(16px,8vw,80px)}
.msg.system{border-left-color:var(--muted);text-align:center;opacity:.75;font-size:clamp(12px,1.3vw,13px)}
.meta{display:block;font-size:clamp(10px,1.2vw,12px);color:var(--muted);margin-bottom:4px;text-transform:capitalize}
.body{word-wrap:break-word}
.code-block{background:var(--code-bg);color:var(--code-text);padding:clamp(8px,1.5vw,12px);border-radius:6px;overflow-x:auto;font-family:'JetBrains Mono',monospace;font-size:clamp(12px,1.3vw,14px);line-height:1.5;margin:8px 0;white-space:pre}
.inline-code{background:var(--code-bg);color:var(--code-text);padding:2px 6px;border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:.9em}
.tool-call{margin:8px 0}
.tool-call summary{cursor:pointer;color:var(--muted);font-size:clamp(12px,1.3vw,13px);padding:4px 0}
.tool-call summary:hover{color:var(--text)}
footer{margin-top:clamp(24px,4vw,40px);padding-top:clamp(12px,2vw,20px);border-top:1px solid var(--border);text-align:center;color:var(--muted);font-size:clamp(11px,1.2vw,13px)}
footer a{color:var(--orange);text-decoration:none}
footer a:hover{text-decoration:underline}
@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
</style>
</head>
<body>
<div class="wrap">
<header>
<h1>8gent Code Session</h1>
<div class="sub">
<span>${date}</span>
<span>Model: ${escapeHtml(metadata.model)}</span>
<span>Duration: ${escapeHtml(metadata.duration)}</span>
<span>${msgCount} messages</span>
</div>
</header>
${messageHtml}
<footer>
<p>Exported from <a href="https://8gent.dev">8gent.dev</a> - session ${escapeHtml(metadata.sessionId)}</p>
</footer>
</div>
</body>
</html>`;
}

/**
 * Save an exported session to disk.
 * Returns the absolute path of the saved file.
 */
export async function saveSessionExport(
  messages: ExportMessage[],
  metadata: ExportMetadata
): Promise<string> {
  const html = await exportSession(messages, metadata);
  const dir = path.join(
    process.env.HOME || process.env.USERPROFILE || ".",
    ".8gent",
    "exports"
  );
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${metadata.sessionId}.html`);
  fs.writeFileSync(filePath, html, "utf-8");
  return filePath;
}
