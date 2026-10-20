#!/usr/bin/env bun
/**
 * Permissions spelling grid (#4509): bun scripts/permissions-grid.ts [--pr-head <rev|dir>]
 * [--base <rev|dir>] [--quick] [--no-shell]. Runs the real commandArgvs + blockedReason from two
 * trees over scripts/permissions-grid.rows.json and prints rows newly blocked, rows newly ALLOWED
 * (exit 1), and named gaps: wipes a real bash/zsh runs (rm, find, sudo stubbed) that both trees allow.
 * Login and interactive shell rows are never run. Wipe names are built from parts at runtime.
 */
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { isolate } from "./permissions-grid-isolate";

const RM = ["r", "m"].join("");
const DEL = ["-de", "lete"].join("");
const NONE = "none";
const MIN_ROWS = 1648; // the shipped matrix: 315 spellings x 5 contexts + 73 benign
const HOME = "/Users/gridhome"; // the home the policy sees; rows spell it literally
const ROWS_FILE = join(import.meta.dir, "permissions-grid.rows.json");
/** Over-skips on purpose: a shell word, then anywhere later a flag cluster with l or i. Such a shell reads profile files that can reset PATH. */
const LOGIN_SHELL =
	/(^|[\s;&|('"])(bash|zsh|sh|dash|ksh)\b[\s\S]*?[\s'"](-[a-zA-Z]*[li][a-zA-Z]*|--login|--interactive)(?=[\s'"]|$)/;

/** Rows that could put a real binary on PATH from inside the probe are never run, isolated or not. */
const PATH_TOUCH = /\/etc\/|\bPATH\b|command\s+-p|\/s?bin\/|\/usr\/|exec\s+-a/;
const noProbe = (t: string) => LOGIN_SHELL.test(t) || PATH_TOUCH.test(t);

export interface Row {
	id: string;
	context: string;
	text: string;
	benign: boolean;
}
type Decision = "BLOCK" | "allow";
export interface GridResult {
	rows: number;
	newlyBlocked: Row[];
	newlyAllowed: Row[];
	gaps: { row: Row; shells: string[] }[];
	skipped: Row[];
	headThrew: Row[];
	aborted?: boolean;
	isolation: string;
	probed: string[];
	baseBlocked: number;
	headBlocked: number;
}

const fill = (s: string) => s.replaceAll("%RM%", () => RM).replaceAll("%DEL%", () => DEL);

export function loadRows(quick: boolean, file = ROWS_FILE): Row[] {
	const d = JSON.parse(readFileSync(file, "utf8"));
	const rows: Row[] = [];
	for (const [context, tpl] of Object.entries<string>(d.contexts)) {
		if (quick && !["plain", "comment"].includes(context)) continue;
		d.spellings.forEach((s: string, i: number) =>
			rows.push({
				id: `${context}#${i}`,
				context,
				text: fill(tpl.replace("%ROW%", () => fill(s))),
				benign: false,
			}),
		);
	}
	d.benign.forEach((s: string, i: number) =>
		rows.push({ id: `benign#${i}`, context: "benign", text: fill(s), benign: true }),
	);
	return rows;
}

/** A tree root: an existing directory as given, or `git archive <rev>` of the two dirs the check imports. */
export function treeRoot(spec: string, scratch: string): string {
	if (existsSync(join(resolve(spec), "packages/permissions/always-blocked.ts")))
		return resolve(spec);
	const dir = mkdtempSync(join(scratch, "tree-"));
	const a = spawnSync(
		"git",
		["archive", "--format=tar", spec, "--", "packages/permissions", "packages/core"],
		{
			maxBuffer: 1 << 28,
		},
	);
	if (a.status !== 0) throw new Error(`git archive ${spec} failed: ${a.stderr?.toString().trim()}`);
	const t = spawnSync("tar", ["-x", "-C", dir], { input: a.stdout });
	if (t.status !== 0) throw new Error(`tar failed: ${t.stderr?.toString().trim()}`);
	return dir;
}

async function decideAll(
	root: string,
	rows: Row[],
	threw: Set<string>,
): Promise<Map<string, Decision>> {
	const mod = await import(join(root, "packages/permissions/always-blocked.ts"));
	if (typeof mod.commandArgvs !== "function" || typeof mod.blockedReason !== "function")
		throw new Error(`${root}: always-blocked.ts must export commandArgvs and blockedReason`);
	const out = new Map<string, Decision>();
	for (const r of rows) {
		let blocked = false;
		try {
			for (const argv of mod.commandArgvs(r.text)) {
				if (mod.blockedReason(argv)) {
					blocked = true;
					break;
				}
			}
		} catch {
			blocked = true; // a throw refuses the command
			threw.add(r.id);
		}
		out.set(r.id, blocked ? "BLOCK" : "allow");
	}
	return out;
}

/** Does a stubbed `RAN ...` line mean a recursive wipe of the root, the home, or a parent of it? */
function isWipe(line: string, homes: string[], kids: Set<string>): boolean {
	const w = line.slice(4).split(" ");
	const wipeOperand = (o: string): boolean => {
		const n = posix.normalize(o).replace(/(.)\/+$/, "$1");
		if (n === "/" || n === "/*" || homes.includes(n) || homes.some((h) => h.startsWith(`${n}/`)))
			return true;
		if (!/[*?[]/.test(o)) return false;
		const re = new RegExp(
			`^${o
				.replace(/[.+^${}()|\\]/g, "\\$&")
				.replace(/\*/g, "[^/]*")
				.replace(/\?/g, "[^/]")}$`,
		);
		return homes.some((h) => re.test(h) || re.test(dirname(h)));
	};
	if (basename(w[0]) === "find") return w.includes(DEL) && wipeOperand(w[1] ?? "");
	const i = w.findIndex((x) => basename(x) === RM);
	if (i < 0) return false;
	const args = w.slice(i + 1);
	if (!args.some((a) => /^-[A-Za-z]*[rR]/.test(a) || a === "--recursive")) return false;
	const operands = args.filter((a) => !a.startsWith("-"));
	return operands.some(wipeOperand) || operands.filter((o) => kids.has(o)).length >= 2;
}

function shellProbe(rows: Row[], scratch: string) {
	const stubs = join(scratch, "stubs");
	const home = join(scratch, "shellhome");
	mkdirSync(stubs);
	mkdirSync(join(home, "docs"), { recursive: true });
	for (const f of [".cfg", "notes", "docs/a"]) writeFileSync(join(home, f), "");
	const kids = new Set([".cfg", "notes", "docs"].map((f) => join(home, f)));
	for (const n of [RM, "find", "sudo"]) {
		writeFileSync(
			join(stubs, n),
			`#!/bin/sh\nprintf 'RAN %s' "\${0##*/}"\nfor a in "$@"; do printf ' %s' "$a"; done\necho\n`,
			{ mode: 0o755 },
		);
	}
	const linux = process.platform === "linux";
	for (const n of [
		"sh",
		"bash",
		"zsh",
		"env",
		"cat",
		"xargs",
		"mount",
		"umount",
		"unshare",
		"setpriv",
	]) {
		const p = Bun.which(n) ?? (n === "sh" || n === "bash" ? `/bin/${n}` : null);
		if (p) (linux ? copyFileSync : symlinkSync)(p, join(stubs, n));
	}
	const sh = join(stubs, "sh");
	const iso = isolate(scratch, stubs, sh);
	if (!iso) return null;
	const shells = [
		["bash", "/bin/bash", ["--noprofile", "--norc", "-c"]],
		["zsh", Bun.which("zsh") ?? "", ["-f", "-c"]],
	].filter(([, p]) => p && existsSync(p as string)) as [string, string, string[]][];
	const ver = (p: string) =>
		spawnSync(p, ["--version"])
			.stdout?.toString()
			.match(/\d+\.\d+(\.\d+)?/)?.[0];
	const labels = shells.map(([n, p]) => `${n} ${ver(p) ?? "?"}`);
	const hits = new Map<string, string[]>();
	for (const r of rows) {
		for (const [si, [, path, flags]] of shells.entries()) {
			const [cmd, args] = iso.wrap([path, ...flags, r.text]);
			const p = spawnSync(cmd, args, {
				env: { PATH: stubs, HOME: home, BASH_ENV: "", ENV: "" },
				cwd: scratch,
				timeout: 5000,
				stdio: ["ignore", "pipe", "ignore"],
			});
			if (iso.lost()) return "aborted"; // the cover failed closed mid-run (secret sentinel file)
			const ran = (p.stdout?.toString() ?? "").split("\n").filter((l) => l.startsWith("RAN "));
			if (ran.some((l) => isWipe(l, [HOME, home], kids)))
				hits.set(r.id, [...(hits.get(r.id) ?? []), labels[si]]);
		}
	}
	return { hits, labels, isolation: iso.name };
}

export async function runGrid(o: {
	head: string;
	base: string;
	quick?: boolean;
	shell?: boolean;
	rows?: string;
}): Promise<GridResult> {
	// os.homedir() is read once at startup, so the fixture home has to be in the environment already.
	if (homedir() !== HOME) throw new Error(`run with HOME=${HOME} (the CLI does this itself)`);
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "permissions-grid-")));
	try {
		// A rows file other than the shipped one is for tests and local use, never CI, and skips the floor.
		const file = o.rows ?? (process.env.NODE_ENV === "test" ? process.env.GRID_ROWS : undefined);
		if (file && process.env.GITHUB_ACTIONS) throw new Error("a rows override is refused in CI");
		const rows = loadRows(!!o.quick, file ?? ROWS_FILE);
		if (!file && !o.quick && rows.length < MIN_ROWS)
			throw new Error(`rows file has ${rows.length} rows, the floor is ${MIN_ROWS}`);
		const threw = new Set<string>();
		const [hd, bd] = await Promise.all([
			decideAll(treeRoot(o.head, scratch), rows, threw),
			decideAll(treeRoot(o.base, scratch), rows, new Set()),
		]);
		const res: GridResult = {
			rows: rows.length,
			newlyBlocked: [],
			newlyAllowed: [],
			gaps: [],
			skipped: [],
			headThrew: rows.filter((r) => r.benign && threw.has(r.id)),
			isolation: "not probed",
			probed: [],
			baseBlocked: [...bd.values()].filter((d) => d === "BLOCK").length,
			headBlocked: [...hd.values()].filter((d) => d === "BLOCK").length,
		};
		for (const r of rows) {
			if (hd.get(r.id) === "BLOCK" && bd.get(r.id) === "allow") res.newlyBlocked.push(r);
			if (hd.get(r.id) === "allow" && bd.get(r.id) === "BLOCK") res.newlyAllowed.push(r);
		}
		if (o.shell !== false) {
			const open = rows.filter(
				(r) => !r.benign && hd.get(r.id) === "allow" && bd.get(r.id) === "allow",
			);
			res.skipped = open.filter((r) => noProbe(r.text));
			const safe = open.filter((r) => !noProbe(r.text));
			const probe = shellProbe(safe, scratch);
			res.aborted = probe === "aborted";
			const out = probe === "aborted" ? null : probe;
			res.isolation = out?.isolation ?? NONE;
			res.probed = out?.labels ?? [];
			for (const r of out ? safe : [])
				if (out?.hits.has(r.id)) res.gaps.push({ row: r, shells: out.hits.get(r.id) as string[] });
		}
		return res;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

const show = (r: Row) => `  ${r.id.padEnd(16)} ${JSON.stringify(r.text).slice(0, 110)}`;
function section(title: string, lines: string[]): void {
	console.log(`\n${title} (${lines.length})`);
	console.log(lines.length ? lines.join("\n") : "  none");
}

export function printGrid(r: GridResult, o: { head: string; base: string; quick?: boolean }): void {
	console.log(`permissions grid: head=${o.head} base=${o.base} ${o.quick ? "quick" : "full"}`);
	const sh = r.probed.join(", ") || "not probed";
	console.log(
		`rows ${r.rows}; blocked on base ${r.baseBlocked}, on head ${r.headBlocked}; shells: ${sh}`,
	);
	console.log(`probe isolation: ${r.isolation}`);
	section("NEWLY BLOCKED on head (information)", r.newlyBlocked.map(show));
	section("NEWLY ALLOWED on head (FAIL)", r.newlyAllowed.map(show));
	section("HEAD THREW on benign rows (FAIL)", r.headThrew.map(show));
	section("probe skipped (login/interactive/path)", r.skipped.map(show));
	if (r.aborted) console.log("\nprobe aborted: isolation lost");
	else if (r.isolation === NONE) console.log("\nprobe skipped: no isolation (static grid only)");
	else {
		const gaps = r.gaps.map((g) => `${show(g.row)}  [${g.shells.join(", ")}]`);
		section("NAMED SPELLING GAPS: run a wipe in a real shell, allowed on both trees", gaps);
	}
	const n = [r.newlyBlocked.length, r.newlyAllowed.length, r.gaps.length];
	console.log(
		`\nresult: newly blocked ${n[0]}, newly allowed ${n[1]}, named gaps ${r.isolation === NONE ? "n/a" : n[2]}`,
	);
}

if (import.meta.main) {
	const a = process.argv.slice(2);
	if (homedir() !== HOME) {
		const c = spawnSync(process.execPath, [import.meta.path, ...a], {
			env: { ...process.env, HOME },
			stdio: "inherit",
		});
		process.exit(c.status ?? 1);
	}
	const arg = (f: string, d: string) => (a.includes(f) ? (a[a.indexOf(f) + 1] ?? d) : d);
	const opts = {
		head: arg("--pr-head", "HEAD"),
		base: arg("--base", "origin/main"),
		quick: a.includes("--quick"),
		shell: !a.includes("--no-shell"),
		rows: a.includes("--rows") ? a[a.indexOf("--rows") + 1] : undefined,
	};
	const res = await runGrid(opts);
	printGrid(res, opts);
	process.exit(res.newlyAllowed.length + res.headThrew.length > 0 ? 1 : res.aborted ? 2 : 0);
}
