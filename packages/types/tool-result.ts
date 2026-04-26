/**
 * 8gent Code - Tool Result Normalization
 *
 * Provides a standard ToolResult shape so every tool consumer
 * gets a predictable contract regardless of how the underlying
 * tool implementation returns data.
 */

export interface ToolResult {
	success: boolean;
	toolName: string;
	result: string;
	error?: string;
	durationMs?: number;
	metadata?: Record<string, unknown>;
}

/**
 * Coerce any tool output into a consistent ToolResult shape.
 *
 * Rules (evaluated in order):
 * 1. string        -> success, result = the string
 * 2. object with .success & .result -> pass through, coerce result to string
 * 3. object with .error or .message -> failure
 * 4. Error instance -> failure with error.message
 * 5. null/undefined -> success, result = ""
 * 6. anything else -> success, result = JSON.stringify(raw)
 */
export function normalizeToolResult(
	toolName: string,
	raw: unknown,
	durationMs?: number,
): ToolResult {
	let out: ToolResult;

	if (typeof raw === "string") {
		out = { success: true, toolName, result: raw };
	} else if (raw instanceof Error) {
		out = { success: false, toolName, result: "", error: raw.message };
	} else if (raw == null) {
		out = { success: true, toolName, result: "" };
	} else if (typeof raw === "object") {
		const obj = raw as Record<string, unknown>;

		if ("success" in obj && "result" in obj) {
			// Pass-through shape -- coerce result to string
			out = {
				success: Boolean(obj.success),
				toolName,
				result:
					typeof obj.result === "string" ? obj.result : String(obj.result),
			};
			if (obj.error !== undefined) {
				out.error = String(obj.error);
			}
			if (obj.metadata !== undefined) {
				out.metadata = obj.metadata as Record<string, unknown>;
			}
		} else if ("error" in obj || "message" in obj) {
			out = {
				success: false,
				toolName,
				result: "",
				error: String(obj.error || obj.message),
			};
		} else {
			out = { success: true, toolName, result: JSON.stringify(raw) };
		}
	} else {
		out = { success: true, toolName, result: JSON.stringify(raw) };
	}

	if (durationMs !== undefined) {
		out.durationMs = durationMs;
	}

	return out;
}
