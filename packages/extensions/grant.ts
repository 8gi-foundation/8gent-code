/**
 * 8gent Code - what an extension grant binds, and per-run approval (#47).
 *
 * A grant (the extension's .enabled file) records the sha256 of the manifest
 * and of the program it names: the resolved command file and every argument
 * that is a file inside the extension folder. A bare command (python3) is
 * looked up on PATH, and its absolute path and its bytes are both recorded,
 * so a swapped or re-ordered interpreter turns the extension off.
 *
 * Tradeoff, said plainly: an interpreter upgrade (brew upgrade python) also
 * turns it off until the person enables it again. What is NOT bound: files
 * the program loads itself (imports, libraries, an interpreter reached
 * through a #! line), and anything that changes between the check and the
 * exec. The check runs at load and again right before every spawn.
 *
 * Unattended runs start nothing unless the person approved this one run in
 * advance: `8gent ext approve-run <name>` asks (default No), then prints a
 * token, an HMAC over (name, grant hash, run id, expiry) signed with a local
 * key at <data dir>/keys/extension-approval.key (0600, made on first use).
 * The host verifies it before every spawn. One run id belongs to one host
 * process: the first process to use it claims it. Nothing leaves the device.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	canonicalStringify,
	getKeyPath,
	loadKeyIfPresent,
	loadOrCreateKey,
} from "../permissions/goal-state-hmac";

export const sha256 = (bytes: Buffer | string): string =>
	createHash("sha256").update(bytes).digest("hex");

const fileSha = (p: string): string => sha256(fs.readFileSync(p));

/** What a grant binds. Compared as canonical JSON, so field order never matters. */
export interface Fingerprint {
	v: 2;
	manifest: string;
	/** The program the host spawns: its absolute path and the sha256 of its bytes. */
	program?: { path: string; sha256: string };
	/** Argument (or legacy entry) as written in the manifest -> sha256 of the file. */
	files: Record<string, string>;
}

const inside = (root: string, p: string) => p === root || p.startsWith(root + path.sep);

/**
 * The absolute program to spawn. A command with a path separator is the
 * extension's own file and must stay inside its folder. A bare name is looked
 * up on the absolute PATH entries only: never the working directory.
 */
export function resolveProgram(
	dir: string,
	command: string,
	pathEnv: string | undefined = process.env.PATH,
): string {
	if (command.includes("/") || command.includes(path.sep)) {
		const root = fs.realpathSync(dir);
		const real = fs.realpathSync(path.resolve(dir, command));
		if (!inside(root, real))
			throw new Error(`command ${JSON.stringify(command)} is outside the extension folder`);
		return real;
	}
	for (const entry of (pathEnv ?? "").split(path.delimiter)) {
		if (!path.isAbsolute(entry)) continue;
		const candidate = path.join(entry, command);
		try {
			if (!fs.statSync(candidate).isFile()) continue;
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {}
	}
	throw new Error(`command ${JSON.stringify(command)} was not found on PATH`);
}

/**
 * Every argument that names an existing file, with its hash. A file outside
 * the folder (an absolute path to /tmp/x.py) is refused: for an interpreter
 * the script is the program, and a file anyone else can write cannot be bound.
 */
function argFiles(dir: string, args: string[]): Record<string, string> {
	const root = fs.realpathSync(dir);
	const files: Record<string, string> = {};
	for (const a of args) {
		const p = path.resolve(root, a);
		let isFile = false;
		try {
			isFile = fs.statSync(p).isFile();
		} catch {}
		if (!isFile) continue;
		if (!inside(root, p))
			throw new Error(
				`argument ${JSON.stringify(a)} names a file outside the extension folder; ship it inside the folder`,
			);
		files[a] = fileSha(p);
	}
	return files;
}

/** Hash the manifest and what it runs. Throws when the program cannot be resolved. */
export function fingerprint(
	dir: string,
	manifestBytes: Buffer,
	run: { command: string; args?: string[] } | { entry?: unknown },
	pathEnv?: string,
): Fingerprint {
	const fp: Fingerprint = { v: 2, manifest: sha256(manifestBytes), files: {} };
	if ("command" in run) {
		const program = resolveProgram(dir, run.command, pathEnv);
		fp.program = { path: program, sha256: fileSha(program) };
		fp.files = argFiles(dir, run.args ?? []);
	} else if (typeof run.entry === "string") {
		// In-process module: bind its entry file the same way.
		const p = path.resolve(dir, run.entry);
		try {
			if (fs.statSync(p).isFile()) fp.files = { [run.entry]: fileSha(p) };
		} catch {}
	}
	return fp;
}

export const grantText = (fp: Fingerprint): string => canonicalStringify(fp);
export const grantHash = (fp: Fingerprint): string => sha256(grantText(fp));

export const changedMessage = (folder: string): string =>
	`program changed since you enabled it; run 8gent ext enable ${folder} to review`;

// ── Per-run approval ────────────────────────────────────────────────────────

export const APPROVAL_KEY = "extension-approval.key";
const DOMAIN = "8gent-ext-approve-run/v1\n";
export const DEFAULT_TTL_MS = 60 * 60 * 1000;
export const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const RUN_ID = /^[0-9a-f]{32}$/;

interface ApprovalPayload {
	v: 1;
	ext: string;
	grant: string;
	run: string;
	exp: number;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const mac = (key: Buffer, body: string) =>
	createHmac("sha256", key)
		.update(DOMAIN + body)
		.digest();

export const newRunId = (): string => randomBytes(16).toString("hex");

/** Sign one approval. Creates the local key on first use. */
export function mintApproval(
	p: { ext: string; grant: string; run: string; ttlMs?: number; now?: number },
	key: Buffer = loadOrCreateKey(APPROVAL_KEY),
): string {
	const ttl = Math.min(Math.max(p.ttlMs ?? DEFAULT_TTL_MS, 1), MAX_TTL_MS);
	if (!RUN_ID.test(p.run)) throw new Error("run id must be 32 hex characters");
	const payload: ApprovalPayload = {
		v: 1,
		ext: p.ext,
		grant: p.grant,
		run: p.run,
		exp: (p.now ?? Date.now()) + ttl,
	};
	const body = b64(canonicalStringify(payload));
	return `${body}.${b64(mac(key, body))}`;
}

export type Approval = { ok: true } | { ok: false; reason: string };

/**
 * Is this unattended spawn approved? Looks for a token for `ext` in
 * EIGHT_EXT_APPROVAL (comma or space separated), checks its signature, the
 * grant hash, EIGHT_RUN_ID and the expiry, then claims the run for this
 * process. Never creates a key: no key means no approval was ever signed.
 */
export function verifyApproval(
	ext: string,
	grant: string,
	opts: {
		env?: Record<string, string | undefined>;
		key?: Buffer | null;
		now?: number;
		pid?: number;
		runsDir?: string;
	} = {},
): Approval {
	const env = opts.env ?? process.env;
	const tokens = (env.EIGHT_EXT_APPROVAL ?? "").split(/[\s,]+/).filter(Boolean);
	if (tokens.length === 0) return { ok: false, reason: "no approval for this run" };
	let key: Buffer | null;
	try {
		key = opts.key === undefined ? loadKeyIfPresent(APPROVAL_KEY) : opts.key;
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err) };
	}
	if (!key) return { ok: false, reason: "no approval key on this device" };

	let reason = "no approval names this extension";
	for (const token of tokens) {
		const [body, sig, extra] = token.split(".");
		if (!body || !sig || extra !== undefined) continue;
		const want = mac(key, body);
		const got = Buffer.from(sig, "base64url");
		if (got.length !== want.length || !timingSafeEqual(got, want)) {
			reason = "approval signature is not valid";
			continue;
		}
		let p: ApprovalPayload;
		try {
			p = JSON.parse(Buffer.from(body, "base64url").toString("utf-8"));
		} catch {
			continue;
		}
		if (p.v !== 1 || p.ext !== ext) continue;
		if (p.grant !== grant) reason = "approval was for a different program";
		else if (!RUN_ID.test(p.run) || p.run !== env.EIGHT_RUN_ID)
			reason = "approval is for a different run (EIGHT_RUN_ID)";
		else if (!(typeof p.exp === "number" && p.exp > (opts.now ?? Date.now())))
			reason = "approval has expired";
		else return claimRun(p.run, p.exp, opts.pid ?? process.pid, opts.runsDir);
	}
	return { ok: false, reason };
}

/**
 * One run id, one host process. O_EXCL makes the first claim win a race; a
 * later process presenting the same run id is refused. A recycled pid could
 * reuse a claim before it expires: bounded by the expiry, not prevented.
 */
function claimRun(run: string, exp: number, pid: number, runsDir?: string): Approval {
	const dir = runsDir ?? path.join(path.dirname(getKeyPath(APPROVAL_KEY)), "extension-runs");
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const marker = path.join(dir, run);
		try {
			const fd = fs.openSync(
				marker,
				fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
				0o600,
			);
			fs.writeFileSync(fd, JSON.stringify({ pid, exp }));
			fs.closeSync(fd);
			return { ok: true };
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			const claimed = JSON.parse(fs.readFileSync(marker, "utf-8"));
			return claimed.pid === pid
				? { ok: true }
				: { ok: false, reason: "approval was already used by another run" };
		}
	} catch (err) {
		return { ok: false, reason: `approval could not be recorded: ${err}` };
	}
}

/** Drop claims whose approvals have expired. Called when a new approval is signed. */
export function pruneRuns(now = Date.now(), runsDir?: string): void {
	const dir = runsDir ?? path.join(path.dirname(getKeyPath(APPROVAL_KEY)), "extension-runs");
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const n of names) {
		try {
			const p = path.join(dir, n);
			if (JSON.parse(fs.readFileSync(p, "utf-8")).exp <= now) fs.rmSync(p);
		} catch {}
	}
}
