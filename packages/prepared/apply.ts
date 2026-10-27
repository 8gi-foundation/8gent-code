/**
 * Approve, reject, landed, list (Owned Duet, #5233 slice 1, layer Gate).
 *
 * Nothing runs unless approve() reaches the exclusive claim. Before that it
 * checks, in order: the packet exists and is still prepared (replay does
 * nothing), the id still matches the action and the stored command matches the
 * one rebuilt from the id (no tampering on disk), the packet is not expired
 * (an expired approval is re-checked and does not run), and the tier is not
 * blocked (a blocked action is refused even when the owner approves it).
 * For a diff it also checks that the base commit is in the owner's history and
 * that the gate still resolves the same from it, and that <id>.patch on disk is
 * byte for byte the classified payload (tamper evidence). What git applies is
 * the verified payload, fed on stdin; the file on disk is never read for apply,
 * so a rename over it after the check changes nothing.
 */

import { spawnSync } from "node:child_process";
import { classifyAction } from "../permissions/action-tiers.js";
import {
	type Packet,
	buildApplyCommand,
	isExpired,
	packetId,
	patchBytes,
	sha256,
	untrustedLabel,
} from "./packet.js";
import { gateCommand, isTrustedBase } from "./pass.js";
import { loadProfile, rank, recordSignal, saveProfile } from "./rank.js";
import type { PreparedIO } from "./store.js";

/** Runs the apply command. `input` is written to its stdin: the verified patch bytes. */
export type Runner = (
	command: string,
	timeoutMs: number,
	input?: string,
) => { code: number; output: string };

export const shellRunner: Runner = (command, timeoutMs, input) => {
	const r = spawnSync("sh", ["-c", command], {
		encoding: "utf8",
		timeout: timeoutMs,
		input: input ?? "",
	});
	return { code: r.status ?? 1, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-4000) };
};

export interface ApproveResult {
	ran: boolean;
	status: Packet["status"] | "unknown" | "replay";
	reason: string;
	gate?: "pass" | "fail" | "n/a";
}

export function resolveId(io: PreparedIO, prefix: string): string | null {
	const hits = io.allPackets().filter((p) => p.id.startsWith(prefix));
	return hits.length === 1 ? hits[0].id : null;
}

export function approve(
	io: PreparedIO,
	id: string,
	opts: { now?: Date; run?: Runner } = {},
): ApproveResult {
	const now = opts.now ?? new Date();
	const p = io.loadPacket(id);
	if (!p) return { ran: false, status: "unknown", reason: "no such packet" };
	const arm = p.shownArm ?? io.armFor(now);
	if (p.status !== "prepared") {
		return { ran: false, status: "replay", reason: `already ${p.status}; nothing done` };
	}
	const isDiff = p.action.kind === "apply_diff_worktree";
	if (p.id !== (isDiff ? packetId(p.action, p.base) : packetId(p.action))) {
		return { ran: false, status: p.status, reason: "packet id does not match its action; refused" };
	}
	if (isDiff && !isTrustedBase(io, p.base)) {
		return {
			ran: false,
			status: p.status,
			reason: "base commit is not in this workspace's history; refused",
		};
	}
	const expected = isDiff
		? buildApplyCommand(io.workspace, io.dir, p.id, gateCommand(io, p.base!), p.base!)
		: "";
	if ((p.action.command ?? "") !== expected || p.apply !== expected) {
		return {
			ran: false,
			status: p.status,
			reason: "stored command differs from the rebuilt one; refused",
		};
	}
	// Re-check on every approve, and always on expiry.
	const tier = classifyAction(p.action, { untrusted: p.source.origin === "untrusted" });
	if (isExpired(p, now)) {
		p.status = "expired";
		io.savePacket(p);
		io.ledger(
			{
				event: "expired",
				id,
				confidence: p.confidence,
				arm,
				reason: `recheck: ${tier.tier}, ${tier.reason}`,
			},
			now,
		);
		return {
			ran: false,
			status: "expired",
			reason: `expired ${p.expires}; re-checked as ${tier.tier}, nothing run, prepare it again`,
		};
	}
	if (tier.tier === "blocked") {
		p.status = "refused";
		io.savePacket(p);
		io.ledger({ event: "blocked", id, confidence: p.confidence, arm, reason: tier.reason }, now);
		return { ran: false, status: "refused", reason: tier.reason };
	}
	// The tier above judged the payload and the command applies the payload from
	// stdin. The display copy on disk must still match: a difference is tampering.
	const patchFile = `${p.id}.patch`;
	const want = isDiff ? patchBytes(p.action.payload) : "";
	if (isDiff) {
		let have: Buffer | null = null;
		try {
			have = io.readBytes(patchFile);
		} catch {}
		const reason =
			have === null || sha256(have) !== sha256(want)
				? "patch on disk differs from the approved payload; refused"
				: "";
		if (reason) {
			p.status = "refused";
			io.savePacket(p);
			io.ledger({ event: "blocked", id, confidence: p.confidence, arm, reason }, now);
			return { ran: false, status: "refused", reason };
		}
	}
	if (!io.claim(`claims/${id}`)) {
		return { ran: false, status: "replay", reason: "approval already claimed; nothing done" };
	}
	let gate: "pass" | "fail" | "n/a" = "n/a";
	let output = "";
	if (p.apply) {
		const r = (opts.run ?? shellRunner)(expected, p.spec.budget.max_seconds * 1000, want);
		gate = r.code === 0 ? "pass" : "fail";
		output = r.output;
	}
	p.status = "approved";
	p.result = { gate, output, at: now.toISOString() };
	io.savePacket(p);
	const profile = loadProfile(io);
	recordSignal(profile, p, "approve");
	saveProfile(io, profile);
	io.ledger({ event: "approved", id, confidence: p.confidence, arm, gate }, now);
	return {
		ran: !!p.apply,
		status: "approved",
		reason: p.apply ? `gate ${gate}` : "draft accepted, nothing to run",
		gate,
	};
}

export function reject(
	io: PreparedIO,
	id: string,
	reason: string,
	now = new Date(),
): ApproveResult {
	const p = io.loadPacket(id);
	if (!p) return { ran: false, status: "unknown", reason: "no such packet" };
	if (!reason.trim()) return { ran: false, status: p.status, reason: "a reject needs a reason" };
	if (p.status !== "prepared")
		return { ran: false, status: "replay", reason: `already ${p.status}` };
	p.status = "rejected";
	p.rejectReason = reason;
	io.savePacket(p);
	const profile = loadProfile(io);
	recordSignal(profile, p, "reject", reason);
	saveProfile(io, profile);
	io.ledger(
		{ event: "rejected", id, confidence: p.confidence, arm: p.shownArm ?? io.armFor(now), reason },
		now,
	);
	return { ran: false, status: "rejected", reason };
}

/** The owner marks an approved item landed once it is merged or used with the gate green. */
export function markLanded(io: PreparedIO, id: string, now = new Date()): ApproveResult {
	const p = io.loadPacket(id);
	if (!p || p.status !== "approved" || p.result?.gate === "fail") {
		return {
			ran: false,
			status: p?.status ?? "unknown",
			reason: "only an approved item with a green or no gate can land",
		};
	}
	if (io.readLedger().some((e) => e.event === "landed" && e.id === id)) {
		return { ran: false, status: "replay", reason: "already landed" };
	}
	io.ledger(
		{ event: "landed", id, confidence: p.confidence, arm: p.shownArm ?? io.armFor(now) },
		now,
	);
	return { ran: false, status: "approved", reason: "landed recorded" };
}

/** Ranked queue. Logs one "shown" per item. The arm is never returned. */
export function listQueue(
	io: PreparedIO,
	opts: { now?: Date; limit?: number; rng?: () => number } = {},
): Packet[] {
	const now = opts.now ?? new Date();
	const arm = io.armFor(now, opts.rng);
	const live = io.allPackets().filter((p) => p.status === "prepared" && !isExpired(p, now));
	const ranked = rank(live, arm, loadProfile(io)).slice(0, opts.limit ?? 10);
	ranked.forEach((p, i) => {
		p.shownArm = arm;
		io.savePacket(p);
		io.ledger({ event: "shown", id: p.id, confidence: p.confidence, arm, rank: i + 1 }, now);
	});
	return ranked;
}

export const labelOf = untrustedLabel;
