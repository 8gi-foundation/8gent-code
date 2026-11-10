/**
 * factory-release: the only way a program leaves quarantine, and only a person can run it.
 * Refuses without a terminal, refuses when the environment marks an unattended run, needs every gate
 * passed at the stamped hash, a reviewer who is not the author, a default-No prompt, and the typed hash.
 * lane.ts never imports this file.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { type LaneConfig, hashVerify, inside, loadConfig, stampAppend } from "./lane";

const UNATTENDED = ["CI", "UNATTENDED", "EIGHT_UNATTENDED", "EIGHT_AUTONOMOUS"];
export const unattended = (env: Record<string, string | undefined>) => UNATTENDED.some((k) => env[k] && !/^(0|false|no)$/i.test(env[k]!));

/** Every precondition except the prompt. Returns the full hash to be typed. Throws with the reason. */
export function releaseChecks(cfg: LaneConfig, dir: string, reviewer: string, tty: boolean, env: Record<string, string | undefined>): string {
	if (!tty) throw new Error("factory-release needs a person at a terminal (stdin is not a terminal)");
	if (unattended(env)) throw new Error("factory-release refuses in an unattended run");
	if (!inside(cfg.quarantineDir, dir)) throw new Error("program is not in quarantine");
	const { hash, author, lines } = hashVerify(dir);
	for (const g of ["S", "A", "B", "C"]) {
		const last = [...lines].reverse().find((l) => l.event === "gate" && l.gate === g && l.hash === hash);
		if (!last?.ok) throw new Error(`gate ${g} has not passed at ${hash.slice(0, 12)}: refusing`);
	}
	if (!cfg.reviewers.includes(reviewer)) throw new Error(`reviewer ${reviewer} is not named in lane.json reviewers`);
	if (reviewer.toLowerCase() === author.toLowerCase()) throw new Error("the author cannot be the reviewer");
	return hash;
}

export async function main(argv: string[], tty = !!process.stdin.isTTY) {
	const [dirArg, ...rest] = argv;
	const opt = (k: string) => rest[rest.indexOf(k) + 1];
	const reviewer = rest.includes("--reviewer") ? opt("--reviewer") : "";
	const dest = rest.includes("--dest") ? path.resolve(opt("--dest")) : "";
	const cfg = loadConfig();
	if (!dirArg || !reviewer || !dest) throw new Error("usage: factory-release <quarantined-program-dir> --reviewer NAME --dest DIR");
	const dir = path.resolve(dirArg);
	const hash = releaseChecks(cfg, dir, reviewer, tty, process.env);
	if (inside(cfg.quarantineDir, dest) || fs.existsSync(dest)) throw new Error("--dest must be a new path outside quarantine");
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		console.log(`program ${path.basename(dir)}\nhash ${hash}\n${fs.readFileSync(path.join(dir, "safety-note.md"), "utf8")}`);
		if (!/^y(es)?$/i.test((await rl.question("Release this program out of quarantine? [y/N] ")).trim())) throw new Error("not released");
		if ((await rl.question("Type the full program hash: ")).trim() !== hash) throw new Error("typed hash does not match: not released");
	} finally { rl.close(); }
	hashVerify(dir);
	fs.mkdirSync(dest, { recursive: true });
	for (const f of ["program.st", "tests.json", "safety-note.md", "stamp.log"]) fs.copyFileSync(path.join(dir, f), path.join(dest, f));
	stampAppend(dir, { event: "released", hash, reviewer, detail: `to ${dest}` });
	console.log(`released ${hash} to ${dest}`);
}

if (import.meta.main) main(process.argv.slice(2)).catch((e) => { console.error(String(e.message)); process.exit(1); });
