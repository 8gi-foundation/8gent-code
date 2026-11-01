/** Test helpers: a throwaway git repo and a prepared dir. Not imported by product code. */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Candidate, Drafter } from "./pass.js";
import { PreparedIO } from "./store.js";

export function sh(cwd: string, cmd: string): string {
	const r = spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr}`);
	return r.stdout;
}

export function fixture() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prep-")));
	const ws = path.join(root, "repo");
	fs.mkdirSync(ws);
	sh(ws, "git init -q -b main && git config user.email a@example.test && git config user.name t");
	fs.writeFileSync(path.join(ws, "a.txt"), "one\n");
	sh(ws, "git add -A && git commit -q -m init");
	const dir = path.join(root, "home", ".8gent", "prepared");
	const io = new PreparedIO(dir, ws);
	/** A real unified diff that adds `name` to the repo. */
	const diffFor = (name: string, body = "two"): string => {
		fs.writeFileSync(path.join(ws, name), `${body}\n`);
		const d = sh(ws, `git add -N ${name} && git diff -- ${name}`);
		sh(ws, `git rm -q -f --cached ${name}; rm ${name}`);
		return d;
	};
	/** The gate lives in the base tree: package.json "typecheck", committed. */
	const setGate = (body: string) => {
		fs.writeFileSync(
			path.join(ws, "package.json"),
			JSON.stringify({ scripts: { typecheck: body } }),
		);
		sh(ws, "git add package.json && git commit -q -m gate");
	};
	/** The env the CLI sees: HOME is the fixture home, so the dir is under ~/.8gent. */
	const env = { HOME: path.join(root, "home"), EIGHT_PREPARED_DIR: dir };
	return { root, ws, dir, io, diffFor, setGate, env };
}

export const cand = (n: number, title = `Fix thing ${n}`, text = "body"): Candidate => ({
	kind: "issue",
	ref: `issue#${n}`,
	title,
	text,
	whyNow: "assigned to you and open",
});

export const diffDrafter =
	(diff: string, confidence = 0.6): Drafter =>
	async () => ({ draft: "d", diff, confidence });
