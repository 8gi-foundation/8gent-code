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
import {
	type ChannelApprovalRequest,
	type ChannelOutcome,
	runWithChannelApprover,
} from "../permissions/index";
import { bus } from "./events";

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Prompt lifetime. EIGHT_APPROVAL_TTL_MS overrides (tests, slow operators). */
export function approvalTtlMs(): number {
	const n = Number(process.env.EIGHT_APPROVAL_TTL_MS);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

export type ApprovalDecision = "approve" | "deny" | "allow_chat" | "undelivered";
export type RespondResult = { ok: true } | { ok: false; reason: "not-live" | "wrong-session" };

interface Pending {
	sessionId: string;
	key: string;
	resolve: (outcome: ChannelOutcome) => void;
	timer: ReturnType<typeof setTimeout>;
}

const OUTCOME: Record<ApprovalDecision, ChannelOutcome> = {
	approve: "approved",
	allow_chat: "approved",
	deny: "denied",
	undelivered: "undelivered",
};

export class ChannelApprovals {
	private pending = new Map<string, Pending>();
	private liveBySession = new Map<string, string>();
	private chatAllowed = new Map<string, Set<string>>();

	/** Ask the session's surface. Only a live, in-time approve resolves "approved". */
	request(
		sessionId: string,
		tool: string,
		input: Record<string, unknown>,
		key: string,
	): Promise<ChannelOutcome> {
		if (this.chatAllowed.get(sessionId)?.has(key)) return Promise.resolve("approved");
		const previous = this.liveBySession.get(sessionId);
		if (previous) this.settle(previous, "replaced");

		const requestId = randomBytes(4).toString("hex");
		return new Promise<ChannelOutcome>((resolve) => {
			const timer = setTimeout(() => this.settle(requestId, "expired"), approvalTtlMs());
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
		this.settle(requestId, OUTCOME[decision]);
		return { ok: true };
	}

	/** Session gone: close its live prompt and forget its chat allowances. */
	endSession(sessionId: string): void {
		const live = this.liveBySession.get(sessionId);
		if (live) this.settle(live, "expired");
		this.chatAllowed.delete(sessionId);
	}

	private settle(requestId: string, outcome: ChannelOutcome): void {
		const p = this.pending.get(requestId);
		if (!p) return;
		clearTimeout(p.timer);
		this.pending.delete(requestId);
		if (this.liveBySession.get(p.sessionId) === requestId) this.liveBySession.delete(p.sessionId);
		// Closed without an answer: tell the surface so the card stops offering buttons.
		if (outcome === "expired" || outcome === "replaced") {
			bus.emit("approval:closed", { sessionId: p.sessionId, requestId, outcome });
		}
		p.resolve(outcome);
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
