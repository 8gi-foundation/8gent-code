/**
 * The prepared dir (Owned Duet, #5233 slice 1): ~/.8gent/prepared, override EIGHT_PREPARED_DIR.
 *
 * Every write the idle pass makes goes through PreparedIO, which asks the
 * policy engine's capability manifest (packages/permissions/capability-manifest.ts)
 * for the tool "prepared_pass" before touching disk. The manifest grants write
 * to the prepared dir and nothing else, resolved through symlinks. This is the
 * enforcement point; there is no other write path in the pass.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { enforceCapability, registerToolManifest } from "../permissions/capability-manifest.js";
import type { Arm, Packet } from "./packet.js";

export const PASS_TOOL = "prepared_pass";

function isLink(p: string): boolean {
	try {
		return fs.lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

export type LedgerEventName =
	| "prepared"
	| "shown"
	| "approved"
	| "rejected"
	| "landed"
	| "blocked"
	| "expired";

export interface LedgerEvent {
	ts: string;
	event: LedgerEventName;
	id: string;
	confidence: number;
	arm: Arm;
	rank?: number;
	reason?: string;
	gate?: string;
}

export class PreparedWriteDenied extends Error {}

/**
 * The prepared dir. EIGHT_PREPARED_DIR may move it, but only to somewhere
 * under ~/.8gent, and never through a symlink: the pass writes here and the
 * approve step applies patches from here, so pointing it at a shared or
 * attacker-owned location must fail loudly instead of quietly working.
 */
export function preparedDir(env: Record<string, string | undefined> = process.env): string {
	const home = env.HOME || os.homedir();
	const base = path.resolve(home, ".8gent");
	const fallback = path.join(base, "prepared");
	const raw = env.EIGHT_PREPARED_DIR;
	const dir = path.resolve(raw || fallback);
	if (!raw) return dir;
	const rel = path.relative(base, dir);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new PreparedWriteDenied(`EIGHT_PREPARED_DIR must be inside ${base}; refused ${dir}`);
	}
	// Every existing component from ~/.8gent down must be a real directory.
	let cursor = base;
	for (const seg of ["", ...rel.split(path.sep)]) {
		cursor = seg ? path.join(cursor, seg) : cursor;
		let st: fs.Stats;
		try {
			st = fs.lstatSync(cursor);
		} catch {
			break;
		}
		if (st.isSymbolicLink() && cursor !== base) {
			throw new PreparedWriteDenied(
				`EIGHT_PREPARED_DIR goes through a symlink at ${cursor}; refused`,
			);
		}
		if (!st.isSymbolicLink() && !st.isDirectory()) {
			throw new PreparedWriteDenied(`EIGHT_PREPARED_DIR: ${cursor} is not a directory; refused`);
		}
	}
	return dir;
}

export class PreparedIO {
	readonly dir: string;
	readonly workspace: string;
	/** One manifest per prepared dir, so two owners in one process cannot widen each other. */
	private readonly tool: string;
	constructor(dir: string, workspace: string, extraRead?: string[]) {
		this.dir = path.resolve(dir);
		if (isLink(this.dir)) throw new PreparedWriteDenied(`prepared dir is a symlink: ${this.dir}`);
		// Owner rules are read verbatim from <home>/.8gent/officers/<code>/rules.md.
		extraRead ??= [path.join(path.dirname(this.dir), "officers")];
		this.workspace = path.resolve(workspace);
		this.tool = `${PASS_TOOL}:${this.dir}`;
		registerToolManifest({
			tool: this.tool,
			fs: { read: [this.workspace, this.dir, ...extraRead], write: [this.dir] },
		});
	}

	private check(kind: "fs_read" | "fs_write", p: string): string {
		const abs = path.isAbsolute(p) ? p : path.join(this.dir, p);
		const d = enforceCapability(
			this.tool,
			{ kind, path: abs },
			{ workingDirectory: this.workspace },
		);
		if (!d.allowed) throw new PreparedWriteDenied(d.reason ?? `${kind} denied: ${abs}`);
		return abs;
	}

	read(p: string): string {
		return fs.readFileSync(this.check("fs_read", p), "utf8");
	}
	readBytes(p: string): Buffer {
		return fs.readFileSync(this.check("fs_read", p));
	}
	exists(p: string): boolean {
		return fs.existsSync(this.check("fs_read", p));
	}
	stat(p: string): fs.Stats {
		return fs.statSync(this.check("fs_read", p));
	}
	list(p: string): string[] {
		return fs.readdirSync(this.check("fs_read", p));
	}
	/**
	 * Make every directory from the prepared dir down to abs's parent, refusing
	 * any component that is a symlink. The manifest check resolves links, but a
	 * write must not even follow one: the leaf is created fresh, never opened.
	 */
	private safeParent(abs: string): void {
		const rel = path.relative(this.dir, path.dirname(abs));
		if (rel.startsWith("..") || path.isAbsolute(rel)) {
			throw new PreparedWriteDenied(`write outside the prepared dir: ${abs}`);
		}
		let cursor = this.dir;
		for (const seg of ["", ...(rel ? rel.split(path.sep) : [])]) {
			cursor = seg ? path.join(cursor, seg) : cursor;
			let st: fs.Stats | null = null;
			try {
				st = fs.lstatSync(cursor);
			} catch {}
			if (!st) fs.mkdirSync(cursor, { recursive: cursor === this.dir });
			else if (st.isSymbolicLink() || !st.isDirectory()) {
				throw new PreparedWriteDenied(`not a plain directory: ${cursor}`);
			}
		}
		if (isLink(abs)) throw new PreparedWriteDenied(`refusing to write through a symlink: ${abs}`);
	}

	/** Atomic: a fresh O_EXCL temp file in the same dir, renamed over the leaf (rename never follows a link). */
	write(p: string, content: string, mode = 0o644): void {
		const abs = this.check("fs_write", p);
		this.safeParent(abs);
		const tmp = path.join(
			path.dirname(abs),
			`.${path.basename(abs)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
		);
		const fd = fs.openSync(
			tmp,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
			0o600,
		);
		try {
			fs.writeFileSync(fd, content);
			fs.fchmodSync(fd, mode);
		} finally {
			fs.closeSync(fd);
		}
		try {
			fs.renameSync(tmp, abs);
		} catch (e) {
			fs.rmSync(tmp, { force: true });
			throw e;
		}
	}
	append(p: string, content: string): void {
		const abs = this.check("fs_write", p);
		this.safeParent(abs);
		const fd = fs.openSync(
			abs,
			fs.constants.O_WRONLY |
				fs.constants.O_APPEND |
				fs.constants.O_CREAT |
				fs.constants.O_NOFOLLOW,
			0o644,
		);
		try {
			fs.writeFileSync(fd, content);
		} finally {
			fs.closeSync(fd);
		}
	}
	/** Exclusive create: false when it already exists. This is the idempotency claim. */
	claim(p: string): boolean {
		const abs = this.check("fs_write", p);
		this.safeParent(abs);
		try {
			const fd = fs.openSync(
				abs,
				fs.constants.O_WRONLY |
					fs.constants.O_CREAT |
					fs.constants.O_EXCL |
					fs.constants.O_NOFOLLOW,
				0o644,
			);
			fs.writeFileSync(fd, new Date().toISOString());
			fs.closeSync(fd);
			return true;
		} catch {
			return false;
		}
	}

	// ---- records ----
	ledger(e: Omit<LedgerEvent, "ts"> & { ts?: string }, now = new Date()): void {
		this.append("ledger.jsonl", `${JSON.stringify({ ts: now.toISOString(), ...e })}\n`);
	}
	readLedger(): LedgerEvent[] {
		if (!this.exists("ledger.jsonl")) return [];
		return this.read("ledger.jsonl")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as LedgerEvent);
	}
	savePacket(p: Packet): void {
		this.write(`${p.id}.json`, `${JSON.stringify(p, null, 2)}\n`);
	}
	loadPacket(id: string): Packet | null {
		return this.exists(`${id}.json`) ? (JSON.parse(this.read(`${id}.json`)) as Packet) : null;
	}
	allPackets(): Packet[] {
		if (!this.exists(".")) return [];
		return this.list(".")
			.filter((f) => /^[0-9a-f]{16}\.json$/.test(f))
			.map((f) => JSON.parse(this.read(f)) as Packet);
	}
	/** One coin flip per local day, kept in state.json, never shown to the owner. */
	armFor(now: Date, rng: () => number = Math.random): Arm {
		const day = now.toLocaleDateString("en-CA");
		const state: { arms?: Record<string, Arm> } = this.exists("state.json")
			? JSON.parse(this.read("state.json"))
			: {};
		state.arms ??= {};
		if (!state.arms[day]) {
			state.arms[day] = rng() < 0.5 ? "profile" : "recency";
			this.write("state.json", `${JSON.stringify(state, null, 2)}\n`);
		}
		return state.arms[day];
	}
}
