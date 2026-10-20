#!/usr/bin/env bun
/**
 * Permissions spelling grid (#4509). Every permissions change runs this before a reader sees it.
 *
 *   bun scripts/permissions-grid.ts [--pr-head <rev|dir>] [--base <rev|dir>] [--quick] [--no-shell]
 *
 * It takes always-blocked.ts from two trees (git archive of a rev, or a directory as given), runs
 * the real commandArgvs + blockedReason over the row matrix in scripts/permissions-grid.rows.json
 * (spellings x contexts, plus benign rows), and prints:
 *   - rows newly blocked on the head (information),
 *   - rows newly ALLOWED on the head (the failure, exit 1),
 *   - named spelling gaps: rows that run a wipe under a real bash and zsh (rm, find and sudo
 *     stubbed, so nothing is ever deleted) and are allowed on both trees (exit 0, listed).
 * --quick runs only the plain and comment contexts. Wipe names are built from parts at runtime.
 */
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";

const RM = ["r", "m"].join("");
const DEL = ["-de", "lete"].join("");
const HOME = "/Users/gridhome"; // the home the policy sees; rows spell it literally
const ROWS_FILE = join(import.meta.dir, "permissions-grid.rows.json");
const QUICK_CONTEXTS = ["plain", "comment"];

export interface Row {
	id: string;
	context: string;
	text: string;
	benign: boolean;
}
export type Decision = "BLOCK" | "allow";
export interface GridResult {
	rows: number;
	newlyBlocked: Row[];
	newlyAllowed: Row[];
	gaps: { row: Row; shells: string[] }[];
	probed: string[];
	baseBlocked: number;
	headBlocked: number;
}

const fill = (s: string) => s.replaceAll("%RM%", () => RM).replaceAll("%DEL%", () => DEL);

export function loadRows(quick: boolean, file = ROWS_FILE): Row[] {
	const d = JSON.parse(readFileSync(file, "utf8"));
	const rows: Row[] = [];
	for (const [context, tpl] of Object.entries<string>(d.contexts)) {
		if (quick && !QUICK_CONTEXTS.includes(context)) continue;
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

async function decideAll(root: string, rows: Row[]): Promise<Map<string, Decision>> {
	const mod = await import(join(root, "packages/permissions/always-blocked.ts"));
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
	// A glob over the home came out as its children: two or more of them is the whole directory.
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
	for (const n of ["sh", "bash", "zsh", "env", "cat", "xargs"]) {
		const p = Bun.which(n) ?? (n === "sh" || n === "bash" ? `/bin/${n}` : null);
		if (p) symlinkSync(p, join(stubs, n));
	}
	const shells = [
		["bash", "/bin/bash"],
		["zsh", Bun.which("zsh") ?? ""],
	].filter(([, p]) => p && existsSync(p));
	const labels = shells.map(([n, p]) => {
		const v =
			spawnSync(p, ["--version"])
				.stdout?.toString()
				.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? "?";
		return `${n} ${v}`;
	});
	const hits = new Map<string, string[]>();
	for (const r of rows) {
		shells.forEach(([, path], si) => {
			const p = spawnSync(path, ["-c", r.text], {
				env: { PATH: stubs, HOME: home },
				cwd: scratch,
				timeout: 5000,
				stdio: ["ignore", "pipe", "ignore"],
			});
			const ran = (p.stdout?.toString() ?? "").split("\n").filter((l) => l.startsWith("RAN "));
			if (ran.some((l) => isWipe(l, [HOME, home], kids)))
				hits.set(r.id, [...(hits.get(r.id) ?? []), labels[si]]);
		});
	}
	return { hits, labels };
}

export async function runGrid(o: {
	head: string;
	base: string;
	quick?: boolean;
	shell?: boolean;
}): Promise<GridResult> {
	// os.homedir() is read once at startup, so the fixture home has to be in the environment already.
	if (homedir() !== HOME) throw new Error(`run with HOME=${HOME} (the CLI does this itself)`);
	const scratch = mkdtempSync(join(tmpdir(), "permissions-grid-"));
	try {
		const rows = loadRows(!!o.quick);
		const [hd, bd] = await Promise.all([
			decideAll(treeRoot(o.head, scratch), rows),
			decideAll(treeRoot(o.base, scratch), rows),
		]);
		const res: GridResult = {
			rows: rows.length,
			newlyBlocked: [],
			newlyAllowed: [],
			gaps: [],
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
			const { hits, labels } = shellProbe(open, scratch);
			res.probed = labels;
			for (const r of open)
				if (hits.has(r.id)) res.gaps.push({ row: r, shells: hits.get(r.id) as string[] });
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
	console.log(
		`permissions grid: head=${o.head} base=${o.base} ${o.quick ? "quick (plain, comment)" : "full"}`,
	);
	console.log(
		`rows ${r.rows}; blocked on base ${r.baseBlocked}, on head ${r.headBlocked}; shells: ${r.probed.join(", ") || "not probed"}`,
	);
	section("NEWLY BLOCKED on head (information)", r.newlyBlocked.map(show));
	section("NEWLY ALLOWED on head (FAIL)", r.newlyAllowed.map(show));
	section(
		"NAMED SPELLING GAPS: run a wipe in a real shell, allowed on both trees",
		r.gaps.map((g) => `${show(g.row)}  [${g.shells.join(", ")}]`),
	);
	console.log(
		`\nresult: newly blocked ${r.newlyBlocked.length}, newly allowed ${r.newlyAllowed.length}, named gaps ${r.gaps.length}`,
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
	};
	const res = await runGrid(opts);
	printGrid(res, opts);
	process.exit(res.newlyAllowed.length > 0 ? 1 : 0);
}
