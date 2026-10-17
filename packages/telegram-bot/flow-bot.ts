/**
 * Flow modes on the Telegram bot (L7): who may signal, and the single-use cards.
 *
 * Built to the 8SO pre-build conditions C1-C26. Nothing here decides a mode.
 * The real controller (packages/flow/flow-mode.ts) is wrapped by controllerFor,
 * which exposes only what the bot may do: ask canSwitch, switch from a card, restore,
 * accept or decline an open proposal. With no controller, or no explicit operator
 * list, every function here is inert: no card is minted, no tap is accepted, no
 * voice note is a flow signal.
 *
 * In memory only (C13, C23): a restart or a session re-create empties the store
 * and every old token then fails as unknown.
 */

import { randomBytes } from "node:crypto";
import {
	type FlowMode,
	type FlowModeController,
	NOT_YOURS,
	type Origin,
	canSwitch,
} from "../flow/flow-mode";
import type { PermissionMode } from "../permissions/permission-mode";

export type FlowModeName = FlowMode;
/** C7. Set by the call site or derived from the stored record kind, never read from callback_data. */
export type FlowOrigin = Origin;
export type CardKind = "menu" | "proposal" | "restore" | "decision";

export type FlowResult = { changed: boolean; mode: FlowModeName; screen?: string; say?: string };

/** The slice of the mode controller the bot needs. It cannot set mode except through these. */
export interface FlowController {
	mode(): FlowModeName;
	/** The pure gate. Origin comes from this file's call sites only. */
	canSwitch(from: FlowModeName, to: FlowModeName, origin: FlowOrigin): boolean;
	/** A tap on a menu card: origin user-button. */
	switchTo(to: FlowModeName): FlowResult;
	/** A tap on a restore card: origin user-button, to the controller's own snapshot. */
	restore(): FlowResult;
	/** Mode before the last switch. Restore never goes above it. */
	snapshot(): FlowModeName | null;
	/** Target of the open inferred proposal. */
	pendingProposal(): FlowModeName | null;
	acceptProposal(to: FlowModeName): FlowResult;
	declineProposal(to: FlowModeName): FlowResult;
}

/** Wraps the real controller. userPerm is the permission mode canSwitch is judged under. */
export function controllerFor(
	real: FlowModeController,
	userPerm: () => PermissionMode = () => "ask",
): FlowController {
	return {
		mode: () => real.mode,
		canSwitch: (from, to, origin) => canSwitch(from, to, origin, userPerm()),
		switchTo: (to) => real.userSwitch(to, "user-button"),
		restore: () => real.restore("user-button"),
		snapshot: () => real.snapshotMode,
		pendingProposal: () => real.pendingProposal,
		acceptProposal: (to) => real.acceptProposal(to),
		declineProposal: (to) => real.declineProposal(to),
	};
}

/** C12. A long expiry only limits stale cards; the security control is the checks around it. */
export const EXPIRY_MS: Record<CardKind, number> = {
	menu: 120_000,
	proposal: 60_000,
	restore: 120_000,
	decision: 600_000,
};
/** C12. Telegram value. The 5 s and 10 s values stay TUI-only. */
export const RAISE_CONFIRM_MS_TELEGRAM = 60_000;
export const PENDING_CAP = 16;
export const PROPOSAL_MIN_GAP_MS = 5 * 60_000;

export const CB_FLOW = { mode: "fm", decision: "fd" } as const;
export function isFlowCallback(data: string | undefined): boolean {
	return /^(fm|fd):/.test(data ?? "");
}

// ── Operators (C1, C2) ───────────────────────────────────────────────

/** Explicit list only. Unlike isOperator, an empty list is "off", never "everyone". */
export function flowOperators(ids: readonly string[] | undefined): string[] {
	return (ids ?? []).map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
}

export function isFlowOperator(ops: readonly string[], fromId: unknown): boolean {
	return ops.length > 0 && typeof fromId === "number" && ops.includes(String(fromId));
}

interface ChatRef {
	id: number;
	type?: string;
}
const privateDmOf = (chat: ChatRef | undefined, fromId: unknown): boolean =>
	!!chat && chat.type === "private" && typeof fromId === "number" && chat.id === fromId;

// ── Voice signal class (C1, C3, C6) ──────────────────────────────────

export type VoiceSource = "user-voice" | "user-forwarded" | "plain";

export function classifyVoice(
	message: {
		from?: { id: number };
		chat: ChatRef;
		forward_origin?: unknown;
		via_bot?: unknown;
	},
	ops: readonly string[],
): VoiceSource {
	if (!isFlowOperator(ops, message.from?.id)) return "plain"; // C6
	if (!privateDmOf(message.chat, message.from?.id)) return "plain"; // C1, C11
	if (message.forward_origin || message.via_bot) return "user-forwarded"; // C3
	return "user-voice";
}

// ── Pending store (C9, C12, C13) ─────────────────────────────────────

export interface PendingRecord {
	kind: CardKind;
	/** Target mode for menu, proposal, restore. Unused for decision. */
	to?: FlowModeName;
	/** Decision cards: which answer this button records. */
	answer?: string;
	chatId: number;
	/** null until the card is sent and its message id is known. */
	messageId: number | null;
	expiresAt: number;
	/** Sibling buttons on one card share a group, so one tap retires the card. */
	group: string;
}

export function createPendingStore(
	now: () => number = Date.now,
	rand: (n: number) => Buffer = randomBytes,
) {
	const records = new Map<string, PendingRecord>();
	let lastProposalAt = Number.NEGATIVE_INFINITY;

	const mintToken = (): string => {
		for (;;) {
			const t = rand(8).toString("base64url");
			if (!records.has(t)) return t;
		}
	};
	return {
		/** C11: a private chat only, asserted here as well as at tap time. Returns null when refused. */
		mint(
			kind: CardKind,
			chatId: number,
			chatType: string | undefined,
			buttons: { to?: FlowModeName; answer?: string }[],
		): string[] | null {
			if (chatType !== "private" || buttons.length === 0) return null;
			if (kind === "proposal") {
				if (now() - lastProposalAt < PROPOSAL_MIN_GAP_MS) return null; // 1 inferred proposal / 5 min
				lastProposalAt = now();
			}
			const group = mintToken();
			const tokens = buttons.map((b) => {
				const token = mintToken();
				records.set(token, {
					kind,
					chatId,
					messageId: null,
					expiresAt: now() + EXPIRY_MS[kind],
					group,
					...b,
				});
				return token;
			});
			while (records.size > PENDING_CAP) {
				const oldest = records.keys().next().value;
				if (oldest === undefined) break;
				records.delete(oldest);
			}
			return tokens;
		},
		bind(tokens: string[], messageId: number): void {
			for (const t of tokens) {
				const r = records.get(t);
				if (r) r.messageId = messageId;
			}
		},
		/** A card that could not be sent leaves nothing behind. */
		drop(tokens: string[]): void {
			for (const t of tokens) records.delete(t);
		},
		peek: (token: string): PendingRecord | undefined => records.get(token),
		/** Single use (C9.4): retires the tapped token and its siblings before anything is applied. */
		consume(token: string): void {
			const r = records.get(token);
			if (!r) return;
			for (const [k, v] of records) if (v.group === r.group) records.delete(k);
		},
		size: () => records.size,
		clear: () => records.clear(),
	};
}
export type PendingStore = ReturnType<typeof createPendingStore>;

// ── Cards ────────────────────────────────────────────────────────────

const LABEL: Record<FlowModeName, string> = {
	listen: "Listen",
	think: "Think",
	quiet: "Quiet",
	act: "Act",
};
type Keyboard = { inline_keyboard: { text: string; callback_data: string }[][] };

const cb = (token: string) => `${CB_FLOW.mode}:${token}`;

/** Fixed text only. Never a transcript, never judge output (C17). */
export function menuCard(
	store: PendingStore,
	chat: { id: number; type?: string },
	ctl: FlowController,
): { text: string; keyboard: Keyboard; tokens: string[] } | null {
	const targets = (["act", "think", "quiet"] as FlowModeName[]).filter((m) => m !== ctl.mode());
	const tokens = store.mint(
		"menu",
		chat.id,
		chat.type,
		targets.map((to) => ({ to })),
	);
	if (!tokens) return null;
	return {
		text: `Mode is ${LABEL[ctl.mode()]}. Pick one.`,
		keyboard: {
			inline_keyboard: [
				targets.map((m, i) => ({ text: LABEL[m], callback_data: cb(tokens[i] as string) })),
			],
		},
		tokens,
	};
}

const QUESTION: Record<FlowModeName, string> = {
	listen: "Want me to just listen?",
	think: "Want to think out loud?",
	quiet: "Want me to go quiet?",
	act: "Want me to get on with it?",
};

/** The judge may only propose a lowering (C8). Refused here if it would raise. */
export function proposalCard(
	store: PendingStore,
	chat: { id: number; type?: string },
	ctl: FlowController,
	to: FlowModeName,
): { text: string; keyboard: Keyboard; tokens: string[] } | null {
	if (!ctl.canSwitch(ctl.mode(), to, "judge")) return null;
	const tokens = store.mint("proposal", chat.id, chat.type, [{ to }, { answer: "no" }]);
	if (!tokens) return null;
	return {
		text: QUESTION[to],
		keyboard: {
			inline_keyboard: [
				[
					{ text: "Yes", callback_data: cb(tokens[0] as string) },
					{ text: "No", callback_data: cb(tokens[1] as string) },
				],
			],
		},
		tokens,
	};
}

/** Restore is a card and never voice alone (R2). Target is the controller's snapshot. */
export function restoreCard(
	store: PendingStore,
	chat: { id: number; type?: string },
	ctl: FlowController,
): { text: string; keyboard: Keyboard; tokens: string[] } | null {
	const to = ctl.snapshot();
	if (!to) return null;
	const tokens = store.mint("restore", chat.id, chat.type, [{ to }]);
	if (!tokens) return null;
	return {
		text: `Back to ${LABEL[to]}?`,
		keyboard: {
			inline_keyboard: [[{ text: `Back to ${LABEL[to]}`, callback_data: cb(tokens[0] as string) }]],
		},
		tokens,
	};
}

/** A question for the operator. Grants nothing: it records one user turn and nothing else. */
export function decisionCard(
	store: PendingStore,
	chat: { id: number; type?: string },
	question: string,
	answers: string[],
): { text: string; keyboard: Keyboard; tokens: string[] } | null {
	const tokens = store.mint(
		"decision",
		chat.id,
		chat.type,
		answers.slice(0, 4).map((answer) => ({ answer })),
	);
	if (!tokens) return null;
	return {
		text: question,
		keyboard: {
			inline_keyboard: [
				answers.slice(0, 4).map((a, i) => ({
					text: a.slice(0, 30),
					callback_data: `${CB_FLOW.decision}:${tokens[i] as string}`,
				})),
			],
		},
		tokens,
	};
}

// ── Tap (C9) ─────────────────────────────────────────────────────────

export interface FlowQuery {
	from?: { id: number };
	data?: string;
	message?: { message_id: number; chat: ChatRef };
}

export interface FlowLogRow {
	at: number;
	from: FlowModeName;
	to: FlowModeName | null;
	origin: FlowOrigin | "none";
	signal: "button" | "restore" | "confirm" | "declined" | "decision" | "stale" | "refused";
	accepted: boolean;
}

export interface TapDeps {
	store: PendingStore;
	ctl: FlowController | undefined;
	ops: readonly string[];
	now?: () => number;
	/** Row has no token, no callback_data, no transcript (C14). */
	log: (row: FlowLogRow) => void;
	/** Records the answer as a user turn tagged "user-button". Never approve or deny, never mode. */
	recordDecision: (answer: string) => void;
}

export interface TapResult {
	/** Short on-screen reason or result; goes to answerCallbackQuery. */
	say: string;
	/** Edit the card to this and clear its keyboard, when set. */
	editTo?: string;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{8,16}$/;
const STALE = "That card is no longer live.";

/** The new, narrow gate for flow taps. A tap that fails it changes nothing. */
export function handleFlowTap(q: FlowQuery, deps: TapDeps): TapResult {
	const now = (deps.now ?? Date.now)();
	const fromMode = deps.ctl?.mode() ?? "act";
	const row = (
		signal: FlowLogRow["signal"],
		accepted: boolean,
		to: FlowModeName | null = null,
		origin: FlowOrigin | "none" = "none",
	) => deps.log({ at: now, from: fromMode, to, origin, signal, accepted });

	// 1. Private DM, operator, from the explicit list. No controller means off.
	const msg = q.message;
	if (
		!deps.ctl ||
		!msg ||
		!privateDmOf(msg.chat, q.from?.id) ||
		!isFlowOperator(deps.ops, q.from?.id)
	) {
		row("refused", false);
		return { say: "Not available here." };
	}

	// callback_data is a lookup key only. Strip the prefix and the y/n flag, never interpret it.
	const m = /^(fm|fd):(.*)$/.exec(q.data ?? "");
	const prefix = m?.[1];
	const token = m?.[2] ?? "";
	// 2. Lookup.
	const rec = TOKEN_RE.test(token) ? deps.store.peek(token) : undefined;
	if (!rec) {
		row("stale", false);
		return { say: STALE };
	}
	// The record kind must match the prefix it was minted under.
	if ((rec.kind === "decision") !== (prefix === CB_FLOW.decision)) {
		row("stale", false);
		return { say: STALE };
	}
	// 3. Same message, same chat.
	if (rec.messageId === null || rec.messageId !== msg.message_id || rec.chatId !== msg.chat.id) {
		row("stale", false);
		return { say: STALE };
	}
	// 4. Expiry, then single use: retire the card before applying anything.
	if (now >= rec.expiresAt) {
		deps.store.consume(token);
		row("stale", false);
		return { say: "That card expired. Nothing changed.", editTo: "Expired. Nothing changed." };
	}
	deps.store.consume(token);

	if (rec.kind === "decision") {
		deps.recordDecision(rec.answer ?? "");
		row("decision", true);
		return { say: "Noted.", editTo: "Noted." };
	}

	// The No button is told apart by its record, never by its data.
	if (rec.kind === "proposal" && rec.answer === "no") {
		const open = deps.ctl.pendingProposal();
		if (open) deps.ctl.declineProposal(open);
		row("declined", true);
		return { say: "Left as is.", editTo: "Left as is." };
	}
	const to = rec.to;
	if (!to) {
		row("stale", false);
		return { say: STALE };
	}
	// 5. Origin comes from the stored kind only (C8).
	const origin: FlowOrigin = rec.kind === "proposal" ? "user-voice-confirmed" : "user-button";
	const cur = deps.ctl.mode();
	// A proposal can never raise: it must also pass the judge gate, and a restore never exceeds the snapshot.
	if (rec.kind === "proposal" && !deps.ctl.canSwitch(cur, to, "judge")) {
		row("refused", false, to, origin);
		return { say: "Not switching, that is yours to set.", editTo: "Not switching." };
	}
	if (rec.kind === "restore" && deps.ctl.snapshot() !== to) {
		row("stale", false, to, origin);
		return { say: STALE };
	}
	if (!deps.ctl.canSwitch(cur, to, origin)) {
		row("refused", false, to, origin);
		return { say: "Not switching.", editTo: "Not switching." };
	}
	const r =
		rec.kind === "proposal"
			? deps.ctl.acceptProposal(to)
			: rec.kind === "restore"
				? deps.ctl.restore()
				: deps.ctl.switchTo(to);
	row(
		rec.kind === "restore" ? "restore" : rec.kind === "proposal" ? "confirm" : "button",
		r.changed,
		to,
		origin,
	);
	if (!r.changed && r.say === NOT_YOURS) return { say: `${NOT_YOURS}.`, editTo: "Not switching." };
	const done = r.changed ? `Mode is ${LABEL[r.mode]}.` : "No change.";
	return { say: done, editTo: done };
}
