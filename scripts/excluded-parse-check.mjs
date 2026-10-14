/**
 * No excluded path may contain a syntax error.
 *
 * Why this exists
 * ---------------
 * `7af2fe38 fix: resolve TS errors in business-builder types + markdown-parser`
 * changed ONE file - tsconfig.json - and touched no source. The commit body says
 * it plainly: "Exclude broken generated files from tsconfig to unblock CI",
 * while the subject says the opposite. The errors were resolved by removing the
 * files from typechecking.
 *
 * Three files still cannot parse:
 *   packages/skills/business-builder/src/types/index.ts
 *   packages/skills/business-builder/.../market-research.ts
 *   packages/tools/markdown-parser.ts
 *
 * The tsconfig `exclude` list contains exactly those three, so `tsc --noEmit`
 * reporting zero errors and those files being broken are the SAME FACT: the
 * files are never opened. Reachable by nothing, checked by nothing.
 *
 * `tsc --noEmit` green and these files broken are not two facts.
 *
 * PARSE ONLY
 * -----------
 * The excluded paths also carry real type errors, and those are excluded
 * deliberately. A file that is not valid TypeScript is a different thing
 * entirely, so this checks only the parse-error class.
 *
 * FAILING LOUDLY
 * --------------
 * Every failure mode here exits non-zero, including the one that matters most:
 * if the checker cannot run, or runs but reports in a format this file does
 * not recognise, that is exit 2 - "did not run" - never exit 0. A gate that
 * cannot fail is worse than no gate, because it is believed.
 *
 * Run: bun run preflight:parse
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Codes meaning "this file is not valid TypeScript", not "this file has type errors". */
export const SYNTAX_CODES = new Set([
	"TS1000", "TS1002", "TS1003", "TS1005", "TS1009", "TS1010", "TS1011",
	"TS1014", "TS1015", "TS1016", "TS1022", "TS1023", "TS1109", "TS1128",
	"TS1144", "TS1160", "TS1434",
]);

/**
 * Directories that must never be walked, even when tsconfig lists them.
 *
 * These are build outputs and installed dependencies, not repo sources. A
 * dependency shipping a .ts fixture with a syntax error would fail this gate
 * for a reason nobody in this repository can fix, so the coverage has to be
 * bounded by the repo, not by whatever is installed on the machine.
 */
const SKIP_TOP_LEVEL = new Set([
	"node_modules",
	"dist",
	"build",
	"coverage",
	".git",
	".next",
]);

/**
 * Parse checker diagnostics in either format.
 *
 * Two shapes are accepted because two checkers are in play, and accepting one
 * silently is how this file previously could have passed on errors:
 *
 *   `bun check`   <error file="a.ts" line="12" column="3" code="TS1005">
 *   `tsc`          a.ts(12,3): error TS1005: ...
 *
 * NOTE the capture indices. matchAll yields [full, g1, g2, g3], so the groups
 * are m[1], m[2], m[3]. Reading m[3] where the path is expected is how a
 * reviewer once saw "No syntax errors" on 27 real errors - so the parser is
 * unit-tested against known input rather than trusted.
 */
export function parseDiagnostics(text) {
	const out = [];
	for (const m of text.matchAll(/<error file="([^"]+)" line="(\d+)"[^>]*code="(TS\d+)"/g)) {
		out.push({ file: m[1], line: Number(m[2]), code: m[3] });
	}
	for (const m of text.matchAll(/([^\s():]+\.[cm]?[jt]sx?)\((\d+),\d+\): error (TS\d+)/g)) {
		out.push({ file: m[1], line: Number(m[2]), code: m[3] });
	}
	return out;
}

/** Repo root from this script's own location - never from process.cwd(). */
export function repoRootFrom(scriptUrl) {
	return dirname(dirname(fileURLToPath(scriptUrl)));
}

function walk(dir, acc = []) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (SKIP_TOP_LEVEL.has(e.name)) continue;
		const p = join(dir, e.name);
		if (e.isDirectory()) walk(p, acc);
		else if (/\.(ts|tsx|mts|cts)$/.test(e.name)) acc.push(p);
	}
	return acc;
}

function runChecker(files) {
	return new Promise((done) => {
		const child = spawn("bun", ["check", ...files], { encoding: "utf8" });
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => { out += d; });
		child.stderr.on("data", (d) => { err += d; });
		child.on("error", (e) => done({ spawned: false, code: null, out, err: e.message }));
		child.on("close", (code) => done({ spawned: true, code, out, err }));
	});
}

async function main() {
	const root = repoRootFrom(import.meta.url);
	const tsconfigPath = join(root, "tsconfig.json");
	if (!existsSync(tsconfigPath)) {
		console.error(`No tsconfig.json at ${root}. Run from a checkout.`);
		process.exit(2);
	}
	const { exclude: excludes = [] } = JSON.parse(readFileSync(tsconfigPath, "utf8"));

	const targets = [];
	const unresolved = [];
	let skipped = 0;
	for (const ex of excludes) {
		const head = ex.replace(/[\\/].*$/, "");
		if (SKIP_TOP_LEVEL.has(head)) {
			skipped++;
			continue;
		}
		const abs = resolve(root, ex);
		// 🔴 An exclude entry that does not resolve is not "nothing to do" - it
		// is a gate that has silently stopped looking. Measured: in a checkout
		// without packages/, both real entries resolved to nothing, zero files were
		// checked, and the gate reported success. Treating that as a pass is the
		// same failure as a regex that matches nothing.
		if (!existsSync(abs)) {
			console.error(`tsconfig exclude entry does not resolve: ${ex}`);
			unresolved.push(ex);
			continue;
		}
		if (statSync(abs).isDirectory()) walk(abs).forEach((f) => targets.push(f));
		else if (/\.(ts|tsx|mts|cts)$/.test(abs)) targets.push(abs);
	}

	if (unresolved.length > 0) {
		console.error(
			`${unresolved.length} tsconfig exclude entr${unresolved.length === 1 ? "y" : "ies"} did not resolve:`,
		);
		for (const ex of unresolved) console.error(`  ${ex}`);
		console.error("");
		console.error(
			"This gate cannot say whether those paths parse if it cannot see them.",
		);
		console.error("Either they are wrong, or this is not a full checkout.");
		process.exit(2);
	}

	if (targets.length === 0) {
		console.log(
			`No TypeScript files are excluded from typechecking (${skipped} build/dependency entries skipped).`,
		);
		console.log("Nothing to check.");
		process.exit(0);
	}

	const diagnostics = [];
	let unknownOutput = "";
	const BATCH = 40;
	for (let i = 0; i < targets.length; i += BATCH) {
		const batch = targets.slice(i, i + BATCH);
		const res = await runChecker(batch);

		if (!res.spawned) {
			console.error(`Could not run \`bun check\`: ${res.err}`);
			console.error("This gate must run, not be skipped.");
			process.exit(2);
		}

		const parsed = parseDiagnostics(res.out);
		diagnostics.push(...parsed);

		if (parsed.length === 0 && res.code !== 0) {
			// The checker exited non-zero but we recognised nothing. Either it did
			// not run, or it speaks a format this file does not parse. Both mean
			// this gate has lost the ability to detect, so it must not pass.
			unknownOutput = res.out + "\n" + res.err;
			console.error(
				`bun check exited ${res.code} on a batch of ${batch.length} file(s) but reported no`,
			);
			console.error("diagnostic this gate can read. The checker did not run, or its output");
			console.error("format changed. Treating that as a FAILURE, not as a pass.");
			console.error(`--- stdout ---\n${res.out.trim().slice(0, 2000)}`);
			console.error(`--- stderr ---\n${res.err.trim().slice(0, 2000)}`);
			process.exit(2);
		}
	}

	const byFile = new Map();
	for (const d of diagnostics) {
		if (!SYNTAX_CODES.has(d.code)) continue;
		if (!byFile.has(d.file)) byFile.set(d.file, []);
		byFile.get(d.file).push(d);
	}

	console.log(
		`${targets.length} excluded TypeScript file(s) checked for parse errors` +
			(skipped ? ` (${skipped} build/dependency entries skipped)` : "") + ".",
	);
	if (byFile.size === 0) {
		console.log("No syntax errors in excluded paths.");
		process.exit(0);
	}

	console.log("");
	for (const [file, errs] of byFile) {
		console.log(`  ${relative(root, resolve(root, file)).replace(/\\/g, "/")}`);
		for (const e of errs) console.log(`      ${e.code} at line ${e.line}`);
	}
	console.log("");
	console.log(`${[...byFile.values()].flat().length} syntax error(s) in ${byFile.size} file(s).`);
	console.log("A file that cannot be parsed is broken regardless of why it is excluded.");
	console.log("Fix it, remove it, or delete it if nothing imports it - but do not leave it");
	console.log("silently unparseable. Restore only with the source, not by re-excluding it.");
	process.exit(1);
}

// Only run when executed, so the exports above can be unit-tested.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	await main();
}