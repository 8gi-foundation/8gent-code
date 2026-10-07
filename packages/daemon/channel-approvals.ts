/**
 * Channel approvals (#3621): the daemon side of "approve it from my phone".
 *
 * A gated shell command in a headless channel session (Telegram) used to be
 * denied outright, and the approval buttons the bridge could draw had nothing
 * behind them. This coordinator is the thing that waits:
 *
 *   - Each prompt gets a short id and a TTL. Silence past the TTL is a deny.
 *   - One live prompt per session. A new prompt denies the old one.
 *   - "Allow in this chat" lets the same command through for the rest of the
 *     session without asking again. It dies with the session.
 *   - Every answer is re-checked here: the id must be live and belong to the
 *     session of the socket that sent it. Late, repeated, superseded and
 *     foreign answers are refused, whatever the surface showed.
 *
 * Who may answer is the surface's job (the bridge's operator check); whether
 * the answer still counts is this module's job.
 */

import { randomBytes } from "node:crypto";
import { type ChannelApprovalRequest, runWithChannelApprover } from "../permissions/index";
import { bus } from "./events";

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Prompt lifetime. EIGHT_APPROVAL_TTL_MS overrides (tests, slow operators). */
export function approvalTtlMs(): number {
	const n = Number(process.env.EIGHT_APPROVAL_TTL_MS);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

export type ApprovalDecision = "approve" | "deny" | "allow_chat";
export type RespondResult = { ok: true } | { ok: false; reason: "not-live" | "wrong-session" };

interface Pending {
	sessionId: string;
	key: string;
	resolve: (approved: boolean) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class ChannelApprovals {
	private pending = new Map<string, Pending>();
	private liveBySession = new Map<string, string>();
	private chatAllowed = new Map<string, Set<string>>();

	/** Ask the session's surface. Resolves true only on a live, in-time approve. */
	request(
		sessionId: string,
		tool: string,
		input: Record<string, unknown>,
		key: string,
	): Promise<boolean> {
		if (this.chatAllowed.get(sessionId)?.has(key)) return Promise.resolve(true);
		const previous = this.liveBySession.get(sessionId);
		if (previous) this.settle(previous, false);

		const requestId = randomBytes(4).toString("hex");
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => this.settle(requestId, false), approvalTtlMs());
			this.pending.set(requestId, { sessionId, key, resolve, timer });
			this.liveBySession.set(sessionId, requestId);
			bus.emit("approval:required", { sessionId, tool, input, requestId });
		});
	}

	/** Apply an answer from a socket bound to `sessionId`. */
	respond(sessionId: string | null, requestId: string, decision: ApprovalDecision): RespondResult {
		const p = this.pending.get(requestId);
		if (!p) return { ok: false, reason: "not-live" };
		if (p.sessionId !== sessionId) return { ok: false, reason: "wrong-session" };
		if (decision === "allow_chat") {
			const set = this.chatAllowed.get(p.sessionId) ?? new Set<string>();
			set.add(p.key);
			this.chatAllowed.set(p.sessionId, set);
		}
		this.settle(requestId, decision !== "deny");
		return { ok: true };
	}

	/** Session gone: deny its live prompt and forget its chat allowances. */
	endSession(sessionId: string): void {
		const live = this.liveBySession.get(sessionId);
		if (live) this.settle(live, false);
		this.chatAllowed.delete(sessionId);
	}

	private settle(requestId: string, approved: boolean): void {
		const p = this.pending.get(requestId);
		if (!p) return;
		clearTimeout(p.timer);
		this.pending.delete(requestId);
		if (this.liveBySession.get(p.sessionId) === requestId) this.liveBySession.delete(p.sessionId);
		p.resolve(approved);
	}
}

export const channelApprovals = new ChannelApprovals();

bus.on("session:end", ({ sessionId, reason }) => {
	if (reason !== "turn-complete") channelApprovals.endSession(sessionId);
});

/** Run one agent turn so its gated shell commands ask this session's surface. */
export function withChannelApprovals<T>(sessionId: string, fn: () => T): T {
	return runWithChannelApprover(
		({ details, command }: ChannelApprovalRequest) =>
			channelApprovals.request(
				sessionId,
				"run_command",
				{ command, reason: details },
				`run_command:${command}`,
			),
		fn,
	);
}
