/**
 * JSON event types for headless runs (`8gent -p ... --mode json`,
 * `8gent run --output-format stream-json`). One JSON object per stdout line.
 * Documented in docs/specs/JSON-EVENTS.md. `run.ts` builds every event through
 * these types, and `validateRunEvent` checks a parsed line against them.
 */

import type { TurnFailureReason } from "./local-turn-error";

export interface RunUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}

export interface SessionStartEvent {
	type: "session_start";
	session_id: string;
	started_at: string;
	provider: string;
	model: string;
	cwd: string;
	/** True when this run continued an earlier session of the folder (--continue / --session). */
	resumed: boolean;
	/** True when the run is saved and can be continued (false with --no-session). */
	persisted: boolean;
}

export interface ToolUseEvent {
	type: "tool_use";
	subtype: "start";
	tool_call_id: string;
	tool_name: string;
	step: number | null;
	input: Record<string, unknown>;
}

export interface ToolResultEvent {
	type: "tool_result";
	subtype: "ok" | "error";
	tool_call_id: string;
	tool_name: string;
	step: number | null;
	success: boolean;
	duration_ms: number;
	result_preview: string;
}

export interface AssistantTextEvent {
	type: "assistant";
	subtype: "text";
	step: number;
	finish_reason: string;
	text: string;
	usage: RunUsage;
}

export interface AssistantToolCallsEvent {
	type: "assistant";
	subtype: "tool_calls";
	step: number;
	finish_reason: string;
	tool_calls: Array<{ toolName: string; toolCallId: string }>;
	usage: RunUsage;
}

export interface ProjectCheckInfo {
	status: string;
	command: string | null;
	fix_rounds: number;
	detail: string | null;
	notice: string | null;
}

/** Which harness guard stopped the run (#4172). Only on a result with subtype "error". */
export type RunStopInfo =
	| { kind: "circuit_breaker"; reason: string }
	| { kind: "watchdog"; reason: string; limit_ms: number }
	| { kind: "formatting_rule_violation"; reason: string; constraint: string; draft: string };

export interface ResultEvent {
	type: "result";
	subtype: "ok" | "error";
	session_id: string;
	ended_at: string;
	final_text?: string;
	project_check?: ProjectCheckInfo;
	error?: string;
	/** Why a turn the harness flagged as failed failed (#3899). */
	reason?: TurnFailureReason;
	/** The claims that stayed unverified, when that is the reason (#3899). */
	unverified?: string[];
	stop?: RunStopInfo;
}

export interface ErrorEvent {
	type: "error";
	subtype: "usage" | "agent";
	message: string;
}

export type RunEvent =
	| SessionStartEvent
	| ToolUseEvent
	| ToolResultEvent
	| AssistantTextEvent
	| AssistantToolCallsEvent
	| ResultEvent
	| ErrorEvent;

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

function validUsage(v: unknown): boolean {
	return isObj(v) && isNum(v.promptTokens) && isNum(v.completionTokens) && isNum(v.totalTokens);
}

/**
 * Returns a list of problems with a parsed event line; empty means it matches
 * the exported types. Unknown extra keys are allowed (the schema may grow).
 */
export function validateRunEvent(e: unknown): string[] {
	if (!isObj(e)) return ["event is not an object"];
	const bad: string[] = [];
	const need = (ok: boolean, what: string) => {
		if (!ok) bad.push(what);
	};
	switch (`${e.type}/${e.subtype ?? ""}`) {
		case "session_start/":
			need(isStr(e.session_id), "session_id");
			need(isStr(e.started_at), "started_at");
			need(isStr(e.provider), "provider");
			need(isStr(e.model), "model");
			need(isStr(e.cwd), "cwd");
			need(typeof e.resumed === "boolean", "resumed");
			need(typeof e.persisted === "boolean", "persisted");
			break;
		case "tool_use/start":
			need(isStr(e.tool_call_id), "tool_call_id");
			need(isStr(e.tool_name), "tool_name");
			need(e.step === null || isNum(e.step), "step");
			need(isObj(e.input), "input");
			break;
		case "tool_result/ok":
		case "tool_result/error":
			need(isStr(e.tool_call_id), "tool_call_id");
			need(isStr(e.tool_name), "tool_name");
			need(e.step === null || isNum(e.step), "step");
			need(typeof e.success === "boolean", "success");
			need(isNum(e.duration_ms), "duration_ms");
			need(isStr(e.result_preview), "result_preview");
			break;
		case "assistant/text":
			need(isNum(e.step), "step");
			need(isStr(e.finish_reason), "finish_reason");
			need(isStr(e.text), "text");
			need(validUsage(e.usage), "usage");
			break;
		case "assistant/tool_calls":
			need(isNum(e.step), "step");
			need(isStr(e.finish_reason), "finish_reason");
			need(
				Array.isArray(e.tool_calls) &&
					e.tool_calls.every((c) => isObj(c) && isStr(c.toolName) && isStr(c.toolCallId)),
				"tool_calls",
			);
			need(validUsage(e.usage), "usage");
			break;
		case "result/ok":
		case "result/error":
			need(isStr(e.session_id), "session_id");
			need(isStr(e.ended_at), "ended_at");
			need(e.final_text === undefined || isStr(e.final_text), "final_text");
			need(e.error === undefined || isStr(e.error), "error");
			need(e.project_check === undefined || isObj(e.project_check), "project_check");
			need(
				e.stop === undefined ||
					(isObj(e.stop) &&
						isStr(e.stop.reason) &&
						(e.stop.kind === "circuit_breaker" ||
							(e.stop.kind === "watchdog" && isNum(e.stop.limit_ms)) ||
							(e.stop.kind === "formatting_rule_violation" &&
								isStr(e.stop.constraint) &&
								isStr(e.stop.draft))) &&
						e.subtype === "error"),
				"stop",
			);
			break;
		case "error/usage":
		case "error/agent":
			need(isStr(e.message), "message");
			break;
		default:
			bad.push(`unknown event ${String(e.type)}/${String(e.subtype ?? "")}`);
	}
	return bad;
}
