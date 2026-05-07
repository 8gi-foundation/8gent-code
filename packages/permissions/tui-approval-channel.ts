/**
 * TUI approval channel.
 *
 * Bridge between PermissionManager (historically blocks on
 * stdin/readline) and any frontend that wants to render approvals
 * itself instead - in particular the V2 TUI's InlineApprovalPrompt.
 *
 * Lifecycle:
 *   1. Frontend boots and calls `registerTuiApprovalHandler(fn)` with
 *      a function that returns a Promise<TuiApprovalDecision>.
 *   2. PermissionManager.requestPermission hits the interactive prompt
 *      branch -> calls `requestTuiApproval(...)` which returns a
 *      Promise<boolean | null>.
 *   3. If the handler is null (headless, CI, legacy chrome), we return
 *      null and PermissionManager falls back to its existing
 *      stdin/readline behavior. Headless wins by default.
 *
 * Lives in packages/permissions because the consumer is here. Frontends
 * just register their handler at boot.
 */

export type TuiApprovalDecision = "approve" | "deny" | "edit" | "skip";

export interface TuiApprovalRequest {
	action: string;
	details: string;
	command?: string;
}

export type TuiApprovalHandler = (
	request: TuiApprovalRequest,
) => Promise<TuiApprovalDecision>;

let handler: TuiApprovalHandler | null = null;

export function registerTuiApprovalHandler(fn: TuiApprovalHandler | null): void {
	handler = fn;
}

export function hasTuiApprovalHandler(): boolean {
	return handler != null;
}

export async function requestTuiApproval(
	request: TuiApprovalRequest,
): Promise<boolean | null> {
	if (!handler) return null;
	try {
		const decision = await handler(request);
		return decision === "approve";
	} catch {
		return null;
	}
}

/** Test-only: clear the registered handler. */
export function _resetTuiApprovalChannel(): void {
	handler = null;
}
