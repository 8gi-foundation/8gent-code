/**
 * Vessel proposal scrub. Principle: local by default, nothing leaves the
 * device. Issue #4937.
 *
 * The rule: nothing that is not a known structural field leaves, ever. Input
 * is accepted only as lines that each parse as one complete JSON object (the
 * session store format). Any other line (truncated, pretty-printed, prose,
 * markdown, a Python repr) is replaced whole by [REDACTED:unstructured]. Inside
 * an object, a key outside the allow-list is dropped together with its value,
 * and the value under an allowed key is held to a strict shape (ids, times,
 * roles, type and tool names); anything else becomes a marker. Free text has
 * no path through this module, so there is no prose pattern to fail open. A
 * last pass over the output replaces anything that still looks like a path,
 * an email or a user@host as defence in depth, never as the gate.
 *
 * Pure: no I/O, no new dependencies.
 */

import { scrub } from "../eight/secret-scanner.js";

export interface ProposalScrubResult {
	text: string;
	redactedCount: number;
	rules: string[];
}

const UNSTRUCTURED = "[REDACTED:unstructured]";
const VALUE_MARKER = "[REDACTED]";
const PATH_MARKER = "[REDACTED:path]";
const EMAIL_MARKER = "[REDACTED:email]";
const MARKER = /^\[REDACTED(?::[a-z]+)?\]$/;

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:?\d\d)?$/;

// Every kept string is checked against a closed set, never a shape: a shape
// lets one word of user text through. Each list is copied from its source.
const ROLES = new Set(["user", "assistant", "system", "tool"]);
// Entry types SessionStore writes (packages/eight/session-store.ts) plus the
// provider content part types stored inside a message.
const TYPES = new Set([
	"session",
	"message",
	"branch_summary",
	"compaction",
	"uncompact",
	"session_info",
	"leaf",
	"text",
	"thinking",
	"reasoning",
	"redacted_thinking",
	"tool_use",
	"tool_result",
	"tool_call",
	"function",
	"image",
	"image_url",
	"input_text",
	"output_text",
]);
// KNOWN_CHANNELS in packages/daemon/agent-pool.ts.
const CHANNELS = new Set([
	"os",
	"app",
	"telegram",
	"discord",
	"api",
	"delegation",
	"computer",
	"browser",
	"table",
	"tui",
	"classroom",
]);
// BuiltinProviderName in packages/providers/index.ts. The model id is dropped.
const PROVIDERS = new Set([
	"8gent",
	"ollama",
	"lmstudio",
	"llama-server",
	"apple-foundation",
	"apfel",
	"deepseek",
	"openrouter",
	"groq",
	"grok",
	"openai",
	"anthropic",
	"mistral",
	"minimax",
	"together",
	"fireworks",
	"replicate",
	"host-cli-primary",
	"host-cli-secondary",
]);
// Tool names from ToolExecutor.getToolDefinitions() (packages/eight/tools.ts).
// Copied so this module stays pure; the test asserts the live registry is a
// subset of this list.
export const TOOL_NAMES: ReadonlySet<string> = new Set([
	"batch",
	"browser_open",
	"browser_screenshot",
	"browser_state",
	"browser_task",
	"check_agent",
	"compare_layout",
	"deck_theme",
	"describe_image",
	"desktop_act",
	"desktop_click",
	"desktop_clipboard",
	"desktop_drag",
	"desktop_hover",
	"desktop_press",
	"desktop_processes",
	"desktop_quit_app",
	"desktop_safe_list",
	"desktop_screenshot",
	"desktop_scroll",
	"desktop_suggest_quit",
	"desktop_type",
	"desktop_windows",
	"edit_file",
	"enable_infinite_mode",
	"extract_video",
	"film_craft",
	"get_outline",
	"get_project_outline",
	"get_symbol",
	"git_add",
	"git_commit",
	"git_diff",
	"git_log",
	"git_status",
	"list_agents",
	"list_files",
	"locate",
	"make_docx",
	"make_pptx",
	"make_xlsx",
	"message_boardroom",
	"query_design_system",
	"read_file",
	"read_image",
	"read_pdf",
	"read_pdf_page",
	"recall",
	"remember",
	"render_video_deck",
	"run_command",
	"run_computer_task",
	"screen_locate",
	"search_files",
	"search_pdf",
	"search_symbols",
	"spawn_agent",
	"speak",
	"suggest_design",
	"term_kill",
	"term_list",
	"term_read",
	"term_send",
	"term_spawn",
	"update_plan",
	"use_skill",
	"vercel_deploy",
	"vercel_get_deployment_logs",
	"vercel_get_deployments",
	"vercel_get_env",
	"vercel_list_domains",
	"vercel_list_projects",
	"vercel_set_env",
	"web_fetch",
	"web_search",
	"write_file",
]);

type Kind = ReadonlySet<string> | "id" | "ts" | "num" | "box";

// The allow-list. "box" keys only hold other objects or arrays; a string or a
// number under one is free text and is redacted. Anything absent is dropped.
const KEYS: Record<string, Kind> = {
	type: TYPES,
	id: "id",
	parentId: "id",
	fromId: "id",
	firstKeptId: "id",
	entryId: "id",
	target: "id",
	tool_call_id: "id",
	toolCallId: "id",
	tool_use_id: "id",
	ts: "ts",
	createdAt: "ts",
	role: ROLES,
	provider: PROVIDERS,
	channel: CHANNELS,
	name: TOOL_NAMES,
	tool: TOOL_NAMES,
	toolName: TOOL_NAMES,
	tool_name: TOOL_NAMES,
	version: "num",
	tokensBefore: "num",
	tokensAfter: "num",
	message: "box",
	content: "box",
	parts: "box",
	function: "box",
	parentSession: "box",
};

interface Tally {
	dropped: number;
	redacted: number;
	ids: Map<string, string>;
}

// Ids are replaced by a counter in order of first appearance: turn order and
// parent links survive, the id itself (which could be anything) does not.
function leaf(v: unknown, kind: Exclude<Kind, "box">, t: Tally): unknown {
	if (v === null) return null;
	if (kind === "id" && typeof v === "string") {
		let n = t.ids.get(v);
		if (!n) {
			n = `e${t.ids.size + 1}`;
			t.ids.set(v, n);
		}
		return n;
	}
	const ok =
		(kind === "ts" && typeof v === "string" && ISO.test(v)) ||
		(kind === "num" && typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1e6) ||
		(typeof kind === "object" && typeof v === "string" && kind.has(v));
	if (ok) return v;
	t.redacted++;
	return VALUE_MARKER;
}

function box(v: unknown, t: Tally): unknown {
	if (typeof v === "string" || typeof v === "number") {
		t.redacted++;
		return VALUE_MARKER;
	}
	if (typeof v === "boolean" || v === null) return v;
	if (Array.isArray(v)) return v.map((x) => box(x, t));
	return walk(v as Record<string, unknown>, t);
}

// Numeric fields are valid on exactly one top-level entry type; anywhere else
// they are a carrier for a number the person typed, so the key is dropped.
const NUM_HOME: Record<string, string> = {
	version: "session",
	tokensBefore: "compaction",
	tokensAfter: "compaction",
};

function walk(o: Record<string, unknown>, t: Tally, top = false): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(o)) {
		const kind = Object.hasOwn(KEYS, k) ? KEYS[k] : undefined;
		// A session's name is the person's own word.
		if (
			!kind ||
			(k === "name" && o.type === "session_info") ||
			(Object.hasOwn(NUM_HOME, k) && !(top && o.type === NUM_HOME[k])) ||
			(k === "version" && !(typeof v === "number" && v >= 1 && v <= 999))
		) {
			t.dropped++;
			continue;
		}
		if (kind === "box") out[k] = box(v, t);
		else if (Array.isArray(v) || (v && typeof v === "object")) {
			t.redacted++;
			out[k] = VALUE_MARKER;
		} else out[k] = leaf(v, kind, t);
	}
	return out;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const USER_AT_HOST = /[A-Za-z0-9._-]+@[A-Za-z0-9._-]+/g;
const PATHISH = /(?:[A-Za-z]:)?(?:\\\\+|\\+|\/+|%2[Ff])(?:[^\s"'`<>|,;()[\]{}]+)/g;

function belt(s: string): { text: string; n: number } {
	let n = 0;
	let out = s.replace(EMAIL, () => {
		n++;
		return EMAIL_MARKER;
	});
	out = out.replace(USER_AT_HOST, (m) => {
		if (MARKER.test(m)) return m;
		n++;
		return EMAIL_MARKER;
	});
	out = out.replace(PATHISH, (m) => {
		n++;
		return PATH_MARKER;
	});
	return { text: out, n };
}

export function scrubProposalText(text: string, _ctx: { home: string }): ProposalScrubResult {
	if (!text) return { text: text ?? "", redactedCount: 0, rules: [] };

	const t: Tally = { dropped: 0, redacted: 0, ids: new Map() };
	let unstructured = 0;
	const lines = text.split("\n").map((raw) => {
		const line = raw.replace(/\r$/, "");
		if (line.trim() === "") return "";
		if (line.trim() === UNSTRUCTURED) return UNSTRUCTURED;
		try {
			const parsed: unknown = JSON.parse(line);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return JSON.stringify(walk(parsed as Record<string, unknown>, t, true));
			}
		} catch {}
		unstructured++;
		return UNSTRUCTURED;
	});

	const first = scrub(lines.join("\n"));
	const b = belt(first.scrubbed);
	const rules = new Set<string>(first.rules);
	if (unstructured) rules.add("unstructured");
	if (t.dropped) rules.add("dropped_key");
	if (t.redacted) rules.add("redacted_value");
	if (b.n) rules.add("belt");
	return {
		text: b.text,
		redactedCount: unstructured + t.dropped + t.redacted + first.redactedCount + b.n,
		rules: [...rules],
	};
}
