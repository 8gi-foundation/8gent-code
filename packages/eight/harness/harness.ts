/**
 * Stateless Harness Loop
 *
 * The harness is the "brain" that reads the session log, decides the next
 * action, executes it via the sandbox, and writes the result back to the
 * session. It holds no state beyond what's in the session file.
 *
 * Crash recovery: restart the harness, point it at the same session file,
 * and it replays the log to reconstruct where it left off.
 *
 * Flow per step:
 *   1. Read all entries from session (replay)
 *   2. Call decide(entries) to get next action (or null to stop)
 *   3. Log the decision to session
 *   4. Inject credentials via vault
 *   5. Execute tool via sandbox
 *   6. Log the result to session
 *   7. Repeat
 *
 * Issue: #1403
 */

import type {
	AuditEntry,
	HarnessAction,
	HarnessConfig,
	HarnessRunResult,
} from "./types";

// SEC-H4: Redact vault sentinel patterns from values before logging
function redactVaultSentinels(obj: unknown): unknown {
	if (typeof obj === "string") {
		return obj.replace(/\$VAULT\{[^}]+\}/g, "$VAULT{***}");
	}
	if (Array.isArray(obj)) return obj.map(redactVaultSentinels);
	if (obj !== null && typeof obj === "object") {
		const clean: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
			clean[k] = redactVaultSentinels(v);
		}
		return clean;
	}
	return obj;
}

/**
 * Run the stateless harness loop.
 *
 * The harness reads the full session on each step (stateless design).
 * The `decide` callback receives the full history and returns the next
 * action, or null to signal completion.
 */
export async function runHarness(
	config: HarnessConfig,
): Promise<HarnessRunResult> {
	const { session, sandbox, vault, maxSteps, decide } = config;

	// Log session start if this is a fresh session
	const existing = await session.readAll();
	if (existing.length === 0) {
		await session.append("session_start", {
			maxSteps,
			tools: sandbox.listTools(),
			vaultKeys: vault.keys().length,
		});
	}

	let steps = 0;
	let completed = false;

	try {
		while (maxSteps === -1 || steps < maxSteps) {
			// Step 1: Read full session (stateless replay)
			const entries = await session.readAll();

			// Step 2: Decide next action
			let action: HarnessAction | null;
			try {
				action = await decide(entries);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				await session.append("error", { phase: "decide", error: message });
				return {
					steps,
					finalHash: await session.lastHash(),
					completed: false,
					error: `Decision error: ${message}`,
				};
			}

			// Null decision means "done"
			if (action === null) {
				completed = true;
				break;
			}

			// Step 3: Log the decision (SEC-H4: redact vault sentinels from input)
			await session.append("decision", {
				tool: action.tool,
				input: redactVaultSentinels(action.input) as Record<string, unknown>,
				reasoning: action.reasoning,
			});

			// Step 4-5: Execute via sandbox (vault injection happens inside sandbox)
			let result: string;
			try {
				result = await sandbox.execute(action.tool, action.input);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				await session.append("tool_result", {
					tool: action.tool,
					success: false,
					error: message,
				});
				// Tool failure is not a harness failure; continue the loop
				steps++;
				continue;
			}

			// Step 6: Log the result
			await session.append("tool_result", {
				tool: action.tool,
				success: true,
				result:
					result.length > 4096
						? result.slice(0, 4096) + "...[truncated]"
						: result,
			});

			steps++;
		}

		// Log session end
		await session.append("session_end", {
			steps,
			completed,
			reason: completed ? "decide_returned_null" : "max_steps_reached",
		});

		return {
			steps,
			finalHash: await session.lastHash(),
			completed,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// Best-effort error logging to session
		try {
			await session.append("error", { phase: "harness", error: message });
		} catch {
			// Session write failed too; nothing we can do
		}
		return {
			steps,
			finalHash: await session.lastHash(),
			completed: false,
			error: message,
		};
	}
}
