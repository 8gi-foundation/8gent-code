/**
 * @8gent/telegram-bot - Mobile Formatter
 *
 * Translates raw agent output into mobile-friendly Telegram messages:
 * - Concise tool-call summaries (one line each)
 * - Truncated middles for long output
 * - Code-block wrapping for files / shell output
 * - Safe message chunking at semantic boundaries
 *
 * Pure functions, no I/O, fully unit-testable.
 */

const MAX_MOBILE_LEN = 1800; // Generous on phones; Telegram cap is 4096.
const MAX_CHUNK_LEN = 3800; // Stay under 4096 to leave room for markup.

export interface ToolSummary {
	icon: string;
	label: string;
	summary?: string;
}

/**
 * Convert a tool name + input into a one-line summary suitable for a
 * progress step. Examples:
 *   read_file({path:"src/auth.ts"}) -> "Reading src/auth.ts"
 *   bash({command:"npm test"})      -> "Running npm test"
 */
export function summarizeToolCall(tool: string, input: unknown): ToolSummary {
	const name = String(tool || "").toLowerCase();
	const args = (input ?? {}) as Record<string, unknown>;

	switch (name) {
		case "read_file":
		case "read":
			return { icon: "📄", label: `Reading ${pickPath(args)}` };

		case "write_file":
		case "write":
			return { icon: "✏️", label: `Writing ${pickPath(args)}` };

		case "edit":
		case "edit_file":
		case "patch":
			return { icon: "✏️", label: `Editing ${pickPath(args)}` };

		case "bash":
		case "shell":
		case "run":
			return { icon: "⚡", label: `Running ${pickCommand(args)}` };

		case "glob":
		case "grep":
		case "search":
		case "find":
			return { icon: "🔎", label: `Searching ${pickQuery(args)}` };

		case "fetch":
		case "web_fetch":
		case "browse":
			return { icon: "🌐", label: `Fetching ${pickUrl(args)}` };

		case "git":
			return { icon: "📦", label: `Git ${pickCommand(args)}` };

		case "agent":
		case "delegate":
		case "spawn":
			return {
				icon: "🤝",
				label: `Delegating: ${truncate(String(args.task ?? args.prompt ?? ""), 60)}`,
			};

		default:
			return { icon: "🔧", label: prettyName(name) };
	}
}

/**
 * Trim verbose tool-result output for a step summary line.
 */
export function summarizeToolResult(output: unknown, durationMs?: number): string {
	const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
	const cleaned = text.replace(/\s+/g, " ").trim();
	const elapsed = durationMs ? ` (${formatMs(durationMs)})` : "";
	if (cleaned.length === 0) return `ok${elapsed}`;
	if (cleaned.length <= 80) return cleaned + elapsed;
	return `${cleaned.slice(0, 77)}...${elapsed}`;
}

/**
 * Truncate long agent output for a phone screen, preserving head + tail.
 */
export function truncateForMobile(text: string, max = MAX_MOBILE_LEN): string {
	if (text.length <= max) return text;
	const headLen = Math.floor((max - 30) * 0.7);
	const tailLen = max - 30 - headLen;
	return `${text.slice(0, headLen)}\n\n_...${text.length - max} chars trimmed..._\n\n${text.slice(-tailLen)}`;
}

/**
 * Split a long message into Telegram-safe chunks at line boundaries.
 * Avoids splitting inside fenced code blocks where possible.
 */
export function splitIntoChunks(text: string, max = MAX_CHUNK_LEN): string[] {
	if (text.length <= max) return [text];
	const chunks: string[] = [];
	let current = "";
	let inFence = false;

	for (const line of text.split("\n")) {
		if (line.startsWith("```")) inFence = !inFence;
		if (current.length + line.length + 1 > max) {
			if (current) {
				// Close an open fence so the chunk stands alone.
				if (inFence) current += "\n```";
				chunks.push(current);
				current = inFence ? "```\n" : "";
			}
			if (line.length > max) {
				for (let i = 0; i < line.length; i += max) {
					chunks.push(line.slice(i, i + max));
				}
				continue;
			}
		}
		current += (current ? "\n" : "") + line;
	}
	if (current) chunks.push(current);
	return chunks;
}

/**
 * Wrap text in a Markdown code fence with optional language.
 * If the text already contains triple-backticks, fall back to inline preview.
 */
export function fence(text: string, lang = ""): string {
	if (text.includes("```")) {
		// Strip backticks rather than break the fence.
		return `\`\`\`${lang}\n${text.replace(/```/g, "ʼʼʼ")}\n\`\`\``;
	}
	return `\`\`\`${lang}\n${text}\n\`\`\``;
}

/**
 * Detect file paths mentioned in agent text. Used by file-sender to attach
 * referenced artifacts automatically.
 */
export function detectFilePaths(text: string): string[] {
	const paths = new Set<string>();
	// Matches paths like /tmp/x.png, ~/Desktop/foo.json, ./src/file.ts.
	const re =
		/(?:^|[\s(`])((?:\.{0,2}\/|~\/|\/)[\w./@-]+\.(?:png|jpg|jpeg|gif|pdf|txt|md|json|ts|tsx|js|jsx|py|sh|toml|yaml|yml|csv|log))(?=[\s),`.]|$)/gim;
	let match: RegExpExecArray | null = re.exec(text);
	while (match !== null) {
		paths.add(match[1]);
		match = re.exec(text);
	}
	return Array.from(paths);
}

/**
 * Format a duration in ms into a short human string.
 */
export function formatMs(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const sec = ms / 1000;
	if (sec < 60) return `${sec.toFixed(1)}s`;
	const min = Math.floor(sec / 60);
	const rem = Math.round(sec - min * 60);
	return `${min}m${rem}s`;
}

// ── helpers ─────────────────────────────────────────────

function pickPath(args: Record<string, unknown>): string {
	const p = args.path ?? args.file ?? args.filename ?? args.target ?? "";
	const text = String(p);
	if (!text) return "(file)";
	return shortenPath(text);
}

function pickCommand(args: Record<string, unknown>): string {
	const cmd = args.command ?? args.cmd ?? args.script ?? args.action ?? "";
	const text = String(cmd);
	if (!text) return "(command)";
	return truncate(text, 60);
}

function pickQuery(args: Record<string, unknown>): string {
	const q = args.query ?? args.pattern ?? args.glob ?? args.regex ?? "";
	const text = String(q);
	if (!text) return "(pattern)";
	return truncate(text, 60);
}

function pickUrl(args: Record<string, unknown>): string {
	const u = args.url ?? args.href ?? "";
	try {
		const parsed = new URL(String(u));
		return parsed.hostname + parsed.pathname;
	} catch {
		return truncate(String(u), 60);
	}
}

function shortenPath(path: string): string {
	const parts = path.split("/").filter(Boolean);
	if (parts.length <= 3) return path;
	return `.../${parts.slice(-2).join("/")}`;
}

function prettyName(name: string): string {
	if (!name) return "Tool call";
	return name.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}
