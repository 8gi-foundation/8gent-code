/**
 * Milestone Detector — finds natural breakpoints in agent conversations.
 *
 * Issue #2420. Token-pressure compaction is reactive; milestone-based
 * compaction is proactive. When a task completes, a file is saved, or a
 * test passes, the conversation has a clean boundary at which an
 * incremental summary is high-fidelity. Compressing at milestones rather
 * than at random offsets preserves more semantic structure.
 *
 * The detector is signal-only — it does not mutate state. Callers decide
 * whether to compress based on signal strength + accumulated growth since
 * the last compression.
 */

export type MilestoneKind =
	| "file_written"
	| "file_read"
	| "test_passed"
	| "test_failed"
	| "command_succeeded"
	| "task_complete"
	| "decision_recorded"
	| "error_recovered";

export interface Milestone {
	kind: MilestoneKind;
	signal: string; // freeform: file path, test name, command, etc.
	at: number;
	/** Confidence 0-1. Used by the compressor to decide whether to act. */
	confidence: number;
}

interface ToolCallShape {
	name: string;
	args?: Record<string, unknown>;
	resultPreview?: string;
	success?: boolean;
}

const FILE_TOOLS = new Set([
	"write_file",
	"edit_file",
	"create_file",
	"WriteFile",
	"EditFile",
	"Write",
	"Edit",
]);

const READ_TOOLS = new Set(["read_file", "Read", "ReadFile", "cat"]);

const TEST_PASS_RE = [
	/(\d+)\s+passed/i,
	/all\s+tests?\s+pass/i,
	/✓\s+/,
	/PASS\s/,
	/test result:\s*ok/i,
];

// "0 failed" is success; require a non-zero count for the failure pattern.
const TEST_FAIL_RE = [/[1-9]\d*\s+failed/i, /test result:\s*FAILED/i, /✗\s+/, /FAIL\s/];

const TASK_COMPLETE_RE = [
	/\btask\s+complete\b/i,
	/\bdone\b\s*[!.]/i,
	/\bfinished\b/i,
	/\bcompleted\b/i,
	/\bshipped\b/i,
];

const DECISION_RE = [
	/\bI('ll| will)\s+(use|go with|pick|choose)\b/i,
	/\bdecid(ed|ing)\s+to\b/i,
	/\bgoing\s+with\b/i,
];

export class MilestoneDetector {
	/**
	 * Inspect a tool call and emit zero or one milestone for it.
	 * Called by the agent loop when a tool finishes.
	 */
	fromToolCall(call: ToolCallShape): Milestone | null {
		const at = Date.now();
		if (FILE_TOOLS.has(call.name)) {
			const path =
				(call.args?.file_path as string | undefined) ??
				(call.args?.path as string | undefined) ??
				(call.args?.filePath as string | undefined);
			if (!path) return null;
			return {
				kind: "file_written",
				signal: path,
				at,
				confidence: call.success === false ? 0.3 : 0.95,
			};
		}
		if (READ_TOOLS.has(call.name)) {
			const path =
				(call.args?.file_path as string | undefined) ?? (call.args?.path as string | undefined);
			if (!path) return null;
			return { kind: "file_read", signal: path, at, confidence: 0.6 };
		}
		if (call.name === "bash" || call.name === "Bash" || call.name === "execute_command") {
			const cmd = (call.args?.command as string | undefined) ?? "";
			const preview = call.resultPreview ?? "";
			// test runs: jest / vitest / bun test / pytest / cargo test
			if (
				/\b(jest|vitest|bun\s+test|pytest|cargo\s+test|go\s+test|npm\s+test|pnpm\s+test|yarn\s+test)\b/i.test(
					cmd,
				)
			) {
				// Check failure FIRST — "1 failed, 4 passed" must classify as test_failed,
				// not test_passed.
				if (TEST_FAIL_RE.some((re) => re.test(preview))) {
					return { kind: "test_failed", signal: cmd.slice(0, 120), at, confidence: 0.9 };
				}
				if (TEST_PASS_RE.some((re) => re.test(preview))) {
					return { kind: "test_passed", signal: cmd.slice(0, 120), at, confidence: 0.9 };
				}
			}
			if (call.success === true && cmd.length > 0) {
				return {
					kind: "command_succeeded",
					signal: cmd.slice(0, 120),
					at,
					confidence: 0.5,
				};
			}
		}
		return null;
	}

	/**
	 * Inspect an assistant text message for high-level signals (task done,
	 * decision recorded). Lower confidence than tool-driven signals.
	 */
	fromAssistantText(text: string): Milestone[] {
		const out: Milestone[] = [];
		const at = Date.now();
		if (TASK_COMPLETE_RE.some((re) => re.test(text))) {
			out.push({ kind: "task_complete", signal: text.slice(0, 120), at, confidence: 0.55 });
		}
		if (DECISION_RE.some((re) => re.test(text))) {
			out.push({
				kind: "decision_recorded",
				signal: text.slice(0, 200),
				at,
				confidence: 0.5,
			});
		}
		return out;
	}
}
