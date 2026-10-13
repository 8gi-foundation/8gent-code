/**
 * Channel approvals (#3621): the daemon side of "approve it from my phone".
 *
 * A gated shell command in a Telegram turn used to be denied outright, and
 * the approval buttons the bridge could draw had nothing behind them. This
 * coordinator is the thing that waits:
 *
 *   - Each prompt gets a short id and a TTL. Silence past the TTL is a deny.
 *   - One live prompt per session. A new prompt closes the old one.
 *   - "Allow this command in this chat" is keyed by (session, chat), lasts
 *     30 minutes, is honoured only on turns the operator started, and is
 *     never offered for commands that run scripts or expand ($, globs, ~, `).
 *   - Only the bridge answers. A socket proves it is the bridge with a secret
 *     held in memory (in-process) or handed over once in
 *     EIGHT_APPROVAL_BRIDGE_SECRET, which is removed from the environment at
 *     load so no child shell inherits it. Every answer is re-checked: the id
 *     must be live and belong to the session of the socket that sent it.
 *   - Every decision, closure and auto-pass is appended to an audit log.
 *
 * Who may press the button is the bridge's job (its operator check).
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type ChannelApprovalRequest,
	type ChannelOutcome,
	runWithChannelApprover,
} from "../permissions/index";
import { bus } from "./events";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_ALLOW_TTL_MS = 30 * 60 * 1000;

/** Longest command a card shows whole. Longer ones are never offered. */
export const CARD_COMMAND_MAX = 3000;

function envMs(name: string, fallback: number): number {
	const n = Number(process.env[name]);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Prompt lifetime. EIGHT_APPROVAL_TTL_MS overrides. */
export function approvalTtlMs(): number {
	return envMs("EIGHT_APPROVAL_TTL_MS", DEFAULT_TTL_MS);
}

// The bridge secret: taken out of the environment before anything can spawn.
const ENV_SECRET = process.env.EIGHT_APPROVAL_BRIDGE_SECRET;
delete process.env.EIGHT_APPROVAL_BRIDGE_SECRET;
const SECRET = ENV_SECRET || randomBytes(32).toString("hex");

/** For the bridge only. Never logged, never put in an env. */
export function bridgeSecret(): string {
	return SECRET;
}

export function isBridgeSecret(candidate: unknown): boolean {
	if (typeof candidate !== "string") return false;
	const a = Buffer.from(candidate);
	const b = Buffer.from(SECRET);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** What the bridge says about the turn it started. Trusted only from the bridge's socket. */
export interface ApprovalTurn {
	chatId: string;
	operator: boolean;
}

export function parseTurn(raw: unknown): ApprovalTurn | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const t = raw as Record<string, unknown>;
	if (typeof t.chatId !== "string" || !t.chatId) return undefined;
	return { chatId: t.chatId, operator: t.operator === true };
}

const EXPANDS = /[$`~*?[\]{}\\]/;
const RUNS_CODE =
	/(^|[\s;&|(])(bash|sh|zsh|dash|ksh|fish|node|bun|bunx|deno|npx|python[0-9.]*|perl|ruby|php|source|eval|exec|xargs|\.)(\s|$)/;

/**
 * May "allow in this chat" cover this command? Not when it runs a script or
 * an interpreter, or expands anything: the same text can do something else
 * next time.
 */
export function allowable(command: string): boolean {
	return !EXPANDS.test(command) && !RUNS_CODE.test(command);
}

export type ApprovalDecision = "approve" | "deny" | "allow_chat" | "undelivered";
export type RespondResult = { ok: true } | { ok: false; reason: "not-live" | "wrong-session" };

const OUTCOME: Record<ApprovalDecision, ChannelOutcome> = {
	approve: "approved",
	allow_chat: "approved",
	deny: "denied",
	undelivered: "undelivered",
};

interface Pending {
	sessionId: string;
	turn: ApprovalTurn;
	command: string;
	resolve: (outcome: ChannelOutcome) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** Append one line to ~/.8gent/approvals-audit.jsonl (0600). Never throws. */
export function auditApproval(line: {
	requestId: string | null;
	approver: string | null;
	chat: string;
	command: string;
	decision: string;
}): void {
	try {
		const dir = process.env.EIGHT_DATA_DIR || join(homedir(), ".8gent");
		mkdirSync(dir, { recursive: true });
		appendFileSync(
			join(dir, "approvals-audit.jsonl"),
			`${JSON.stringify({ ts: new Date().toISOString(), ...line })}\n`,
			{ mode: 0o600 },
		);
	} catch (err) {
		console.error("[channel-approvals] audit write failed:", (err as Error).message);
	}
}

export class ChannelApprovals {
	private pending = new Map<string, Pending>();
	private liveBySession = new Map<string, string>();
	/** `${sessionId}\n${chatId}` -> command -> allowance expiry. */
	private allowances = new Map<string, Map<string, number>>();

	/** Ask the bridge. Only a live, in-time approve resolves "approved". */
	request(
		sessionId: string,
		turn: ApprovalTurn,
		command: string,
		input: Record<string, unknown>,
	): Promise<ChannelOutcome> {
		const until = this.allowances.get(`${sessionId}\n${turn.chatId}`)?.get(command);
		if (turn.operator && until !== undefined && until > Date.now()) {
			auditApproval({
				requestId: null,
				approver: "allowance",
				chat: turn.chatId,
				command,
				decision: "auto-allow",
			});
			return Promise.resolve("approved");
		}
		const previous = this.liveBySession.get(sessionId);
		if (previous) this.settle(previous, "replaced", null);

		const requestId = randomBytes(4).toString("hex");
		return new Promise<ChannelOutcome>((resolve) => {
			const timer = setTimeout(() => this.settle(requestId, "expired", null), approvalTtlMs());
			this.pending.set(requestId, { sessionId, turn, command, resolve, timer });
			this.liveBySession.set(sessionId, requestId);
			bus.emit("approval:required", {
				sessionId,
				tool: "run_command",
				input: { ...input, command, chatId: turn.chatId, allowable: allowable(command) },
				requestId,
			});
		});
	}

	/** Apply the bridge's answer from a socket bound to `sessionId`. */
	respond(
		sessionId: string | null,
		requestId: string,
		decision: ApprovalDecision,
		approver: string | null = null,
	): RespondResult {
		const p = this.pending.get(requestId);
		if (!p) return { ok: false, reason: "not-live" };
		if (p.sessionId !== sessionId) return { ok: false, reason: "wrong-session" };
		// "Allow in this chat" on a command that may not be allowed is one approve.
		const effective = decision === "allow_chat" && !allowable(p.command) ? "approve" : decision;
		if (effective === "allow_chat") {
			const scope = `${p.sessionId}\n${p.turn.chatId}`;
			const map = this.allowances.get(scope) ?? new Map<string, number>();
			map.set(p.command, Date.now() + envMs("EIGHT_APPROVAL_ALLOW_TTL_MS", DEFAULT_ALLOW_TTL_MS));
			this.allowances.set(scope, map);
		}
		this.settle(requestId, OUTCOME[effective], approver, effective);
		return { ok: true };
	}

	/** The bridge's own session ended: close its live prompt, forget its allowances. */
	endSession(sessionId: string): void {
		const live = this.liveBySession.get(sessionId);
		if (live) this.settle(live, "expired", null);
		for (const key of this.allowances.keys()) {
			if (key.startsWith(`${sessionId}\n`)) this.allowances.delete(key);
		}
	}

	private settle(
		requestId: string,
		outcome: ChannelOutcome,
		approver: string | null,
		decision: string = outcome,
	): void {
		const p = this.pending.get(requestId);
		if (!p) return;
		clearTimeout(p.timer);
		this.pending.delete(requestId);
		if (this.liveBySession.get(p.sessionId) === requestId) this.liveBySession.delete(p.sessionId);
		auditApproval({ requestId, approver, chat: p.turn.chatId, command: p.command, decision });
		// Closed without an answer: tell the bridge so the card stops offering buttons.
		if (outcome === "expired" || outcome === "replaced") {
			bus.emit("approval:closed", { sessionId: p.sessionId, requestId, outcome });
		}
		p.resolve(outcome);
	}
}

export const channelApprovals = new ChannelApprovals();

/**
 * Run one bridge-started turn so its gated shell commands ask the bridge.
 * `cwd` is shown on the card. A command too long to show whole is never offered.
 */
export function withChannelApprovals<T>(
	sessionId: string,
	turn: ApprovalTurn,
	cwd: string,
	fn: () => T,
): T {
	return runWithChannelApprover(async ({ details, command }: ChannelApprovalRequest) => {
		if (command.length > CARD_COMMAND_MAX) {
			auditApproval({
				requestId: null,
				approver: null,
				chat: turn.chatId,
				command,
				decision: "unshowable",
			});
			return "unshowable";
		}
		return channelApprovals.request(sessionId, turn, command, { reason: details, cwd });
	}, fn);
}
