/** `8gent prepared`: list, pass, approve, reject, landed, blocked. Plain output; the arm is never printed. */

import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { diffPaths } from "../permissions/action-tiers.js";
import { approve, listQueue, markLanded, reject, resolveId } from "./apply.js";
import { type Packet, diffStat, untrustedLabel } from "./packet.js";
import { runPass } from "./pass.js";
import { PreparedIO, preparedDir } from "./store.js";

export type Confirm = (question: string) => Promise<boolean>;

/** Default No. With no terminal to ask on, the answer is No: unattended means no. */
export const ttyConfirm: Confirm = async (question) => {
	if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const a = await rl.question(`${question} [y/N] `);
		return /^y(es)?$/i.test(a.trim());
	} finally {
		rl.close();
	}
};

/** What a diff changes, in plain lines: the stat per file, then every path the patch names. */
export function describeChange(p: Packet, full = false): string {
	if (p.action.kind !== "apply_diff_worktree") return "   changes: none (draft only, nothing runs)";
	const stat = diffStat(p.action.payload);
	const all = new Set(diffPaths(p.action.payload));
	// diffPaths keeps a/x and x both (git strips the first component); show x once.
	const touched = [...all].filter((t) => !/^[ab]\//.test(t) || !all.has(t.slice(2)));
	const lines = [
		`   diff: ${stat.length} file(s), +${stat.reduce((n, f) => n + f.added, 0)} -${stat.reduce((n, f) => n + f.removed, 0)}`,
		...stat.map((f) => `     ${f.path}  +${f.added} -${f.removed}`),
		`   touches: ${touched.join(", ")}`,
	];
	if (full)
		lines.push("   --- full diff ---", p.action.payload.replace(/\n$/, ""), "   --- end diff ---");
	return lines.join("\n");
}

export async function preparedCommand(
	args: string[],
	env: Record<string, string | undefined> = process.env,
	out: (s: string) => void = console.log,
	confirm: Confirm = ttyConfirm,
): Promise<number> {
	const json = args.includes("--json");
	const full = args.includes("--diff");
	const rest = args.filter((a) => a !== "--json" && a !== "--diff");
	const ri = rest.indexOf("--reason");
	const reason = ri >= 0 ? (rest[ri + 1] ?? "") : "";
	if (ri >= 0) rest.splice(ri, 2);
	let io: PreparedIO;
	try {
		io = new PreparedIO(preparedDir(env), process.cwd());
	} catch (e) {
		out(`prepared: ${(e as Error).message}`);
		return 1;
	}
	const sub = rest[0] ?? "list";

	if (sub === "list") {
		const q = listQueue(io);
		if (json)
			out(
				JSON.stringify(
					q.map(({ shownArm, ...p }) => p),
					null,
					2,
				),
			);
		else if (q.length === 0) out("Nothing prepared.");
		else
			q.forEach((p, i) =>
				out(
					`${i + 1}. ${p.id}  conf ${p.confidence.toFixed(2)}  ${untrustedLabel(p)}${p.title}\n   why now: ${p.why_now}\n${describeChange(p, full)}\n   apply: ${p.apply || "(draft only, nothing runs)"}\n   undo: ${p.undo}\n   expires: ${p.expires}`,
				),
			);
		return 0;
	}
	if (sub === "pass") {
		const r = await runPass(io);
		out(`prepared ${r.prepared.length}, blocked ${r.blocked.length}, skipped ${r.skipped}`);
		return 0;
	}
	if (sub === "blocked") {
		const d = path.join(io.dir, "blocked");
		for (const f of fs.existsSync(d) ? fs.readdirSync(d) : []) {
			const b = JSON.parse(io.read(`blocked/${f}`));
			out(`${b.id}  ${b.title}\n   missing: ${b.missing}`);
		}
		return 0;
	}
	const id = rest[1] ? resolveId(io, rest[1]) : null;
	if (!["approve", "reject", "landed"].includes(sub)) {
		out(
			"Usage: 8gent prepared [list [--diff]|pass|blocked|approve <id> [--diff]|reject <id> --reason <why>|landed <id>]",
		);
		return 2;
	}
	if (!id) {
		out(`No single packet matches "${rest[1] ?? ""}".`);
		return 1;
	}
	if (sub === "approve") {
		const p = io.loadPacket(id)!;
		out(
			`${p.id}  ${untrustedLabel(p)}${p.title}\n${describeChange(p, full)}\n   apply: ${p.apply || "(draft only, nothing runs)"}`,
		);
		if (!(await confirm(`Approve ${p.id} and run the command above?`))) {
			out(`approve ${id}: not confirmed; nothing done`);
			return 1;
		}
	}
	const r =
		sub === "approve"
			? approve(io, id)
			: sub === "reject"
				? reject(io, id, reason)
				: markLanded(io, id);
	out(json ? JSON.stringify(r) : `${sub} ${id}: ${r.status}, ${r.reason}`);
	return (r.status === "approved" && r.gate !== "fail") || r.status === "rejected" ? 0 : 1;
}
