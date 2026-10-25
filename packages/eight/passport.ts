/**
 * The 8gent passport, slice 1 (#5086): the owner's skills and plugs in one self-issued file.
 *
 *   8gent passport export [--out <file>]   write a deterministic tar.gz the owner holds
 *   8gent passport import <file>           verify every sha256, dry run, ask [y/N]
 *   8gent passport show [file] [--plain]   print the card
 *   8gent passport delete                  remove the passport files export made
 *
 * Spec: docs/specs/PASSPORT.md. Local only: nothing here opens a socket, and nothing here
 * reads packages/secrets or the keychain. Keys and tokens are kept out by construction: a
 * skill or plug that holds a secrets file or a key-shaped string is left out whole.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveHome } from "../core/home";
import { askOneYesDetailed, isUnattendedReason } from "../core/one-yes";
import { buildArchive } from "../marketplace/archive";
import { detectSecrets } from "../permissions/secret-detector";
import { type TarEntry, TarRefusal, readBounded, writeEntries } from "./passport-tar";

type Env = Record<string, string | undefined>;

export const PASSPORT_ROOT = "passport";
export const PASSPORT_SCHEMA_VERSION = 1;
export const CARD_WIDTH = 40;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
/** Unpacked limits, checked from the tar listing before anything is extracted. */
const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".cache"]);
/** File names that may hold keys or tokens. Never opened, the whole item is left out. */
const SECRET_FILE =
	/^(\.env(\..*)?|.*\.env|keys\.env|auth(\..*)?|.*credential.*|.*token.*|.*secret.*|.*keychain.*|.*\.(pem|key|p12|pfx))$/i;

export type SkillOrigin = "owner" | "learned" | "imported";

export interface PassportSkill {
	name: string;
	/** Folder inside the passport: skills/<name>. Holds SKILL.md as-is. */
	path: string;
	/** 8gent extras live only here, never inside SKILL.md. */
	metadata: { "8gent": { origin: SkillOrigin; tool?: string } };
}

export interface PassportPlug {
	name: string;
	/** Folder inside the passport: plugs/<name>. Holds 8gent-extension.json. */
	path: string;
	version: string;
	permissions: string[];
}

export interface PassportManifest {
	schemaVersion: 1;
	kind: "8gent-passport";
	issuer: "self-issued";
	created: string;
	sections: { skills: PassportSkill[]; plugs: PassportPlug[] };
	leftOut: { section: "skills" | "plugs"; name: string; reason: string }[];
	/** sha256 of every file in the passport except manifest.json, keyed by path under passport/. */
	files: Record<string, string>;
}

export interface PassportIO {
	env?: Env;
	input?: NodeJS.ReadableStream & { isTTY?: boolean };
	output?: NodeJS.WritableStream & { isTTY?: boolean };
	/** Tests only: a piped input stands in for a person. Never set in product code. */
	assumeAttended?: boolean;
}

class PassportError extends Error {
	constructor(
		message: string,
		readonly code: number,
	) {
		super(message);
	}
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const eightDir = (env: Env) => path.join(resolveHome(env), ".8gent");
const passportDir = (env: Env) => path.join(eightDir(env), "passport");
const issuedFile = (env: Env) => path.join(passportDir(env), "issued.json");

// ── collect ──────────────────────────────────────────────────────────────

interface Candidate {
	section: "skills" | "plugs";
	name: string;
	/** Passport path -> absolute source path. */
	files: [string, string][];
	skill?: PassportSkill;
	plug?: PassportPlug;
}

const isDir = (p: string) => {
	try {
		return fs.lstatSync(p).isDirectory();
	} catch {
		return false;
	}
};
const sortedEntries = (dir: string) => (isDir(dir) ? fs.readdirSync(dir).sort() : []);

/**
 * Every regular file under dir, sorted. A link or an oversized file throws. Export skips build and
 * cache folders; import passes skip=false so every file on disk is held to the manifest.
 */
function walkFiles(dir: string, rel = "", skip = true): string[] {
	const out: string[] = [];
	for (const name of sortedEntries(path.join(dir, rel))) {
		const childRel = rel ? `${rel}/${name}` : name;
		const st = fs.lstatSync(path.join(dir, childRel));
		if (st.isSymbolicLink()) throw new Error(`holds a link (${childRel})`);
		if (st.isDirectory()) {
			if (!skip || !SKIP_DIRS.has(name)) out.push(...walkFiles(dir, childRel, skip));
		} else if (!st.isFile()) {
			throw new Error(`holds a special file (${childRel})`);
		} else {
			if (st.size > MAX_FILE_BYTES) throw new Error(`file over 5 MB (${childRel})`);
			out.push(childRel);
		}
	}
	return out;
}

function skillCandidates(home8: string): Candidate[] {
	const out: Candidate[] = [];
	const flat = (dir: string, origin: SkillOrigin) => {
		for (const f of sortedEntries(dir)) {
			const abs = path.join(dir, f);
			if (!f.endsWith(".md") || !fs.lstatSync(abs).isFile()) continue;
			const name = f.slice(0, -3);
			out.push({
				section: "skills",
				name,
				files: [[`skills/${name}/SKILL.md`, abs]],
				skill: { name, path: `skills/${name}`, metadata: { "8gent": { origin } } },
			});
		}
	};
	flat(path.join(home8, "skills"), "owner");
	flat(path.join(home8, "learned-skills"), "learned");
	const imported = path.join(home8, "imported");
	for (const tool of sortedEntries(imported)) {
		const root = path.join(imported, tool, "skills");
		for (const name of sortedEntries(root)) {
			const dir = path.join(root, name);
			if (!isDir(dir) || !fs.existsSync(path.join(dir, "SKILL.md"))) continue;
			const c: Candidate = {
				section: "skills",
				name,
				files: [],
				skill: {
					name,
					path: `skills/${name}`,
					metadata: { "8gent": { origin: "imported", tool } },
				},
			};
			try {
				c.files = walkFiles(dir).map((r) => [`skills/${name}/${r}`, path.join(dir, r)]);
			} catch (e) {
				c.files = [["", (e as Error).message]];
			}
			out.push(c);
		}
	}
	return out;
}

function plugCandidates(home8: string): Candidate[] {
	const out: Candidate[] = [];
	const root = path.join(home8, "extensions");
	for (const name of sortedEntries(root)) {
		const dir = path.join(root, name);
		const manifestPath = path.join(dir, "8gent-extension.json");
		if (!isDir(dir) || !fs.existsSync(manifestPath)) continue;
		const c: Candidate = { section: "plugs", name, files: [] };
		try {
			const m = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
			c.plug = {
				name,
				path: `plugs/${name}`,
				version: typeof m.version === "string" ? m.version : "0.0.0",
				permissions: Array.isArray(m.permissions) ? m.permissions.map(String).sort() : [],
			};
			c.files = walkFiles(dir).map((r) => [`plugs/${name}/${r}`, path.join(dir, r)]);
		} catch (e) {
			c.files = [["", (e as Error).message]];
		}
		out.push(c);
	}
	return out;
}

/** Why this item cannot travel, or null. Opens a file only after its name passed the secrets check. */
function refusal(c: Candidate, taken: Set<string>): string | null {
	if (!SAFE_NAME.test(c.name)) return "name is not portable";
	if (c.files.length === 1 && c.files[0][0] === "") return c.files[0][1];
	if (taken.has(`${c.section}/${c.name}`)) return "same name as another item";
	for (const [rel] of c.files) {
		if (SECRET_FILE.test(path.posix.basename(rel))) return `holds a secrets file (${rel})`;
	}
	for (const [rel, abs] of c.files) {
		if (detectSecrets(fs.readFileSync(abs, "utf-8")).length > 0)
			return `looks like a key or token (${rel})`;
	}
	return null;
}

// ── export ───────────────────────────────────────────────────────────────

function createdAt(env: Env): Date {
	const epoch = Number(env.SOURCE_DATE_EPOCH);
	return Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000) : new Date();
}

function writeStaged(stageRoot: string, rel: string, data: Buffer | string): void {
	const abs = path.join(stageRoot, ...rel.split("/"));
	fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o755 });
	fs.writeFileSync(abs, data, { mode: 0o644 });
	fs.chmodSync(abs, 0o644);
}

/**
 * The tar entries are sorted with fixed times, but gzip stamps the time it ran into bytes 4-7.
 * Zero means "no time" in RFC 1952 and no checksum covers it, so the same input is the same file.
 */
function zeroGzipTime(file: string): void {
	const buf = fs.readFileSync(file);
	if (buf[0] !== 0x1f || buf[1] !== 0x8b || (buf[3] & 0x02) !== 0) return;
	buf.fill(0, 4, 8);
	fs.writeFileSync(file, buf);
}

interface Issued {
	files: { path: string; sha256: string; created: string }[];
}

function readIssued(env: Env): Issued {
	try {
		const raw = JSON.parse(fs.readFileSync(issuedFile(env), "utf-8"));
		return Array.isArray(raw?.files) ? raw : { files: [] };
	} catch {
		return { files: [] };
	}
}

export function exportPassport(
	outArg: string | undefined,
	env: Env,
): { file: string; manifest: PassportManifest } {
	const home8 = eightDir(env);
	const created = createdAt(env);
	const manifest: PassportManifest = {
		schemaVersion: 1,
		kind: "8gent-passport",
		issuer: "self-issued",
		created: created.toISOString(),
		sections: { skills: [], plugs: [] },
		leftOut: [],
		files: {},
	};
	const stamp = manifest.created.slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
	const file = path.resolve(
		outArg ?? path.join(passportDir(env), `8gent-passport-${stamp}.tar.gz`),
	);
	if (fs.existsSync(file)) throw new PassportError(`Refused: ${file} already exists.`, 1);

	const stageParent = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-passport-"));
	const stageRoot = path.join(stageParent, PASSPORT_ROOT);
	try {
		const taken = new Set<string>();
		for (const c of [...skillCandidates(home8), ...plugCandidates(home8)]) {
			const why = refusal(c, taken);
			if (why) {
				manifest.leftOut.push({ section: c.section, name: c.name, reason: why });
				continue;
			}
			taken.add(`${c.section}/${c.name}`);
			for (const [rel, abs] of c.files) {
				const data = fs.readFileSync(abs);
				writeStaged(stageRoot, rel, data);
				manifest.files[rel] = sha256(data);
			}
			if (c.skill) manifest.sections.skills.push(c.skill);
			if (c.plug) manifest.sections.plugs.push(c.plug);
		}
		writeStaged(stageRoot, "manifest.json", `${JSON.stringify(manifest, null, "\t")}\n`);
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		buildArchive({
			stagingDir: stageParent,
			rootName: PASSPORT_ROOT,
			outPath: file,
			portable: true,
		});
		zeroGzipTime(file);
		fs.chmodSync(file, 0o600);
	} finally {
		fs.rmSync(stageParent, { recursive: true, force: true });
	}

	const issued = readIssued(env);
	issued.files.push({
		path: file,
		sha256: sha256(fs.readFileSync(file)),
		created: manifest.created,
	});
	fs.mkdirSync(passportDir(env), { recursive: true, mode: 0o700 });
	fs.writeFileSync(issuedFile(env), `${JSON.stringify(issued, null, "\t")}\n`, { mode: 0o600 });
	return { file, manifest };
}

// ── open and verify ──────────────────────────────────────────────────────

interface Opened {
	root: string;
	manifest: PassportManifest;
	close: () => void;
}

export function openPassport(file: string): Opened {
	if (!fs.existsSync(file)) throw new PassportError(`No file at ${file}.`, 1);
	if (fs.statSync(file).size > MAX_ARCHIVE_BYTES)
		throw new PassportError("Refused: the passport is over 50 MB.", 4);
	// Gunzip with a hard output cap and check every tar header in-process before anything is
	// written. System tar never reads an imported passport.
	let entries: TarEntry[];
	try {
		entries = readBounded(file, PASSPORT_ROOT, {
			maxFileBytes: MAX_FILE_BYTES,
			maxTotalBytes: MAX_UNPACKED_BYTES,
			maxEntries: MAX_ENTRIES,
		});
	} catch (e) {
		if (e instanceof TarRefusal) throw new PassportError(`Refused: ${e.message}.`, 4);
		throw e;
	}

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-passport-open-"));
	const close = () => fs.rmSync(tmp, { recursive: true, force: true });
	try {
		try {
			writeEntries(entries, tmp);
		} catch (e) {
			if (e instanceof TarRefusal)
				throw new PassportError(`Refused: ${e.message}. Nothing was written.`, 4);
			throw e;
		}
		const root = path.join(tmp, PASSPORT_ROOT);
		const fail = (why: string): never => {
			throw new PassportError(`Refused: ${why}. Nothing was written.`, 4);
		};
		let manifest: PassportManifest;
		try {
			manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf-8"));
		} catch {
			return fail("manifest.json is missing or unreadable");
		}
		if (manifest?.schemaVersion !== 1 || manifest.kind !== "8gent-passport")
			fail("this is not a version 1 passport");
		const listed = Object.keys(manifest.files ?? {}).sort();
		let present: string[];
		try {
			present = walkFiles(root, "", false).filter((r) => r !== "manifest.json");
		} catch (e) {
			return fail((e as Error).message);
		}
		if (present.join("\n") !== listed.join("\n")) fail("the file list does not match the manifest");
		for (const rel of listed) {
			if (sha256(fs.readFileSync(path.join(root, rel))) !== manifest.files[rel])
				fail(`${rel} does not match its sha256`);
		}
		const items = [
			...(manifest.sections?.skills ?? []).map((s) => ["skills", s.name, s.path] as const),
			...(manifest.sections?.plugs ?? []).map((p) => ["plugs", p.name, p.path] as const),
		];
		for (const [section, name, p] of items) {
			if (!SAFE_NAME.test(name) || p !== `${section}/${name}`)
				fail(`${section} entry ${name} is not valid`);
		}
		for (const s of manifest.sections.skills) {
			const tool = s.metadata?.["8gent"]?.tool;
			if (tool !== undefined && !SAFE_NAME.test(tool))
				fail(`skill ${s.name} names an invalid tool`);
			if (!manifest.files[`${s.path}/SKILL.md`]) fail(`skill ${s.name} has no SKILL.md`);
		}
		const owned = new Set(items.map(([, , p]) => `${p}/`));
		for (const rel of listed) {
			const top = rel.split("/").slice(0, 2).join("/");
			if (!owned.has(`${top}/`)) fail(`${rel} belongs to no listed item`);
			if (detectSecrets(fs.readFileSync(path.join(root, rel), "utf-8")).length > 0)
				fail(`${rel} looks like a key or token`);
		}
		return { root, manifest, close };
	} catch (e) {
		close();
		throw e;
	}
}

// ── card ─────────────────────────────────────────────────────────────────

/** The passport card. 40 columns, every status a word, no colour needed to read it. */
export function renderCard(
	m: PassportManifest,
	opts: { bordered: boolean; hashes: "verified" | "not checked" },
): string {
	const when = `${m.created.slice(0, 10)} ${m.created.slice(11, 16)} UTC`;
	const lines = [
		"8gent passport",
		"self-issued",
		`Made: ${when}`,
		`Skills: ${m.sections.skills.length} included`,
		`Plugs: ${m.sections.plugs.length} included`,
		"Memory: not included",
		"Track record: not included",
		"Keys and tokens: never included",
		`Left out: ${m.leftOut.length}`,
		`Hashes: ${opts.hashes}`,
	];
	const inner = CARD_WIDTH - 4;
	const fit = (s: string) => (s.length > inner ? `${s.slice(0, inner - 3)}...` : s);
	if (!opts.bordered) return lines.map(fit).join("\n");
	const rule = "-".repeat(CARD_WIDTH - 2);
	return [`+${rule}+`, ...lines.map((l) => `| ${fit(l).padEnd(inner)} |`), `+${rule}+`].join("\n");
}

// ── import ───────────────────────────────────────────────────────────────

interface Step {
	kind: "skill" | "plug";
	name: string;
	action: "new" | "skip";
	reason?: string;
	/** Skills: where it lands. Plugs: the quarantine. */
	dest: string;
	/** Folder skill (imported origin) or flat SKILL.md file. */
	flat?: boolean;
	src: string;
	permissions?: string[];
	/** Plugs: the manifest-listed files, relative to src. */
	files?: string[];
}

/** Manifest text shown on a terminal: no escape codes or control characters get through. */
const printable = (s: string) =>
	String(s)
		.replace(/[^A-Za-z0-9 ._:/@+-]/g, "?")
		.slice(0, 64);

function planImport(o: Opened, env: Env): Step[] {
	const home8 = eightDir(env);
	const hasImportedHere = fs.existsSync(path.join(home8, "imported", "manifest.json"));
	const steps: Step[] = [];
	for (const s of o.manifest.sections.skills) {
		const meta = s.metadata?.["8gent"] ?? { origin: "owner" as SkillOrigin };
		const src = path.join(o.root, s.path);
		const onlySkillMd = fs.readdirSync(src).join() === "SKILL.md";
		let dest: string;
		let flat = true;
		if (meta.origin === "learned") dest = path.join(home8, "learned-skills", `${s.name}.md`);
		else if (meta.origin === "imported" && meta.tool && hasImportedHere) {
			dest = path.join(home8, "imported", meta.tool, "skills", s.name);
			flat = false;
		} else dest = path.join(home8, "skills", `${s.name}.md`);
		const step: Step = { kind: "skill", name: s.name, action: "new", dest, flat, src };
		if (flat && !onlySkillMd) {
			step.action = "skip";
			step.reason = "has extra files; bring your other tools home here first";
		} else if (fs.existsSync(dest)) {
			step.action = "skip";
			step.reason = "already here";
		}
		steps.push(step);
	}
	for (const p of o.manifest.sections.plugs) {
		const step: Step = {
			kind: "plug",
			name: p.name,
			action: "new",
			dest: path.join(home8, "quarantine"),
			src: path.join(o.root, p.path),
			permissions: Array.isArray(p.permissions) ? p.permissions : [],
			files: Object.keys(o.manifest.files)
				.filter((f) => f.startsWith(`${p.path}/`))
				.map((f) => f.slice(p.path.length + 1)),
		};
		if (fs.existsSync(path.join(home8, "extensions", p.name))) {
			step.action = "skip";
			step.reason = "already installed";
		} else if (quarantinedNames(home8).has(p.name)) {
			step.action = "skip";
			step.reason = "already in quarantine";
		}
		steps.push(step);
	}
	return steps;
}

function quarantinedNames(home8: string): Set<string> {
	try {
		const reg = JSON.parse(
			fs.readFileSync(path.join(home8, "quarantine", "registry.json"), "utf-8"),
		);
		return new Set(
			(reg.entries ?? [])
				.filter((e: { status?: string }) => e.status !== "rejected")
				.map((e: { name?: string }) => String(e.name)),
		);
	} catch {
		return new Set();
	}
}

const tilde = (p: string, env: Env) => {
	const home = resolveHome(env);
	return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
};

function copyNew(src: string, dest: string): void {
	// "wx": never overwrite, even if something landed between the plan and the write.
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.writeFileSync(dest, fs.readFileSync(src), { flag: "wx" });
}

async function applyImport(steps: Step[], env: Env, say: (l: string) => void): Promise<void> {
	const home8 = eightDir(env);
	for (const s of steps.filter((x) => x.action === "new" && x.kind === "skill")) {
		if (s.flat) {
			copyNew(path.join(s.src, "SKILL.md"), s.dest);
		} else {
			fs.mkdirSync(path.dirname(s.dest), { recursive: true });
			fs.mkdirSync(s.dest);
			for (const rel of walkFiles(s.src, "", false))
				copyNew(path.join(s.src, rel), path.join(s.dest, rel));
		}
	}
	const plugs = steps.filter((x) => x.action === "new" && x.kind === "plug");
	if (plugs.length === 0) return;
	// Imported plugs never go to ~/.8gent/extensions: the quarantine lane holds and scans them,
	// and the plug loader never reads it, so a plug stays off until the owner promotes it.
	const { QuarantineManager } = await import("../quarantine/index");
	const q = new QuarantineManager({
		quarantineDir: path.join(home8, "quarantine"),
		autoApprove: false,
		autoReject: true,
	});
	for (const p of plugs) {
		// Only the listed, verified files, copied into a fresh folder: that folder is what quarantine sees.
		const stage = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-passport-plug-"));
		let entry: Awaited<ReturnType<typeof q.quarantine>>;
		try {
			const dir = path.join(stage, "plug");
			for (const rel of p.files ?? []) {
				const to = path.join(dir, ...rel.split("/"));
				fs.mkdirSync(path.dirname(to), { recursive: true });
				fs.copyFileSync(path.join(p.src, ...rel.split("/")), to);
			}
			entry = await q.quarantine(dir, p.name, "local");
		} finally {
			fs.rmSync(stage, { recursive: true, force: true });
		}
		const scan = await q.scan(entry.id);
		const where = q.get(entry.id)?.status === "rejected" ? "rejected" : "scanned";
		say(
			`Plug ${p.name}: in quarantine, scan ${scan.verdict}, off until you promote it (${tilde(path.join(home8, "quarantine", where, entry.id), env)}).`,
		);
	}
}

async function importPassport(file: string, io: PassportIO, env: Env, say: (l: string) => void) {
	const o = openPassport(path.resolve(file));
	try {
		say(`Hashes: verified (${Object.keys(o.manifest.files).length} files).`);
		const steps = planImport(o, env);
		for (const s of steps) {
			const what = s.action === "new" ? `-> ${tilde(s.dest, env)}` : `(${s.reason})`;
			const asks = s.permissions?.length
				? `, asks for ${s.permissions.map(printable).join(", ")}`
				: "";
			say(`  ${s.action.padEnd(4)}  ${s.kind}  ${s.name} ${what}${asks}`);
		}
		const n = steps.filter((s) => s.action === "new").length;
		const line = `Dry run: ${n} new, ${steps.length - n} skipped.`;
		const r = await askOneYesDetailed(`${line} Apply? [y/N]`, {
			label: "passport-import",
			env,
			input: io.input,
			output: io.output,
			assumeAttended: io.assumeAttended,
		});
		if (isUnattendedReason(r.reason)) {
			say(line);
			throw new PassportError(
				"Nobody at a terminal to answer, so nothing was written. Run it yourself in a terminal.",
				2,
			);
		}
		if (!r.answer) {
			say("Nothing written.");
			return;
		}
		await applyImport(steps, env, say);
		const skills = steps.filter((s) => s.action === "new" && s.kind === "skill").length;
		say(`Imported ${skills} skill${skills === 1 ? "" : "s"}. Skipped ${steps.length - n}.`);
	} finally {
		o.close();
	}
}

// ── delete ───────────────────────────────────────────────────────────────

function deletePassports(env: Env, say: (l: string) => void): void {
	const issued = readIssued(env);
	if (issued.files.length === 0) {
		say("No passport files to remove.");
		return;
	}
	for (const f of issued.files) {
		if (!fs.existsSync(f.path)) {
			say(`Already gone: ${f.path}`);
			continue;
		}
		if (sha256(fs.readFileSync(f.path)) !== f.sha256) {
			say(`Left in place, changed since it was made: ${f.path}`);
			continue;
		}
		fs.unlinkSync(f.path);
		say(`Removed: ${f.path}`);
	}
	fs.unlinkSync(issuedFile(env));
	say(`Removed: ${issuedFile(env)}`);
	try {
		fs.rmdirSync(passportDir(env));
	} catch {
		// Not empty: something else lives there, and it stays.
	}
}

// ── entry ────────────────────────────────────────────────────────────────

const USAGE = `Usage:
  8gent passport export [--out <file>]
  8gent passport import <file>
  8gent passport show [file] [--plain]
  8gent passport delete`;

/** `8gent passport ...`. Returns the exit code. bin/8gent.ts calls exactly this. */
export async function runPassport(args: string[], io: PassportIO = {}): Promise<number> {
	const env = io.env ?? process.env;
	const output = io.output ?? process.stdout;
	const say = (l: string) => output.write(`${l}\n`);
	const [sub, ...rest] = args;
	const flag = (name: string) => {
		const i = rest.indexOf(name);
		return i >= 0 ? rest[i + 1] : undefined;
	};
	const positional = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--out");
	try {
		switch (sub) {
			case "export": {
				if (rest.includes("--out") && !flag("--out")) throw new PassportError(USAGE, 1);
				const { file, manifest } = exportPassport(flag("--out"), env);
				for (const l of manifest.leftOut) say(`Left out: ${l.section} ${l.name} (${l.reason})`);
				const check = openPassport(file);
				check.close();
				say(`File: ${file}`);
				say(renderCard(manifest, { bordered: Boolean(output.isTTY), hashes: "verified" }));
				say("Saved. You hold the only copy.");
				return 0;
			}
			case "import": {
				if (!positional[0]) throw new PassportError(USAGE, 1);
				await importPassport(positional[0], io, env, say);
				return 0;
			}
			case "show": {
				const bordered = Boolean(output.isTTY) && !rest.includes("--plain");
				const file =
					positional[0] ??
					readIssued(env)
						.files.filter((f) => fs.existsSync(f.path))
						.at(-1)?.path;
				if (!file) {
					say("No passport yet. Make one with: 8gent passport export");
					return 0;
				}
				const o = openPassport(path.resolve(file));
				o.close();
				say(renderCard(o.manifest, { bordered, hashes: "verified" }));
				return 0;
			}
			case "delete":
				deletePassports(env, say);
				return 0;
			default:
				say(USAGE);
				return sub === undefined || sub === "help" || sub === "--help" ? 0 : 1;
		}
	} catch (e) {
		if (e instanceof PassportError) {
			say(e.message);
			return e.code;
		}
		say(`Passport failed: ${e instanceof Error ? e.message : String(e)}`);
		return 1;
	}
}
