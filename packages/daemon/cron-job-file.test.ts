import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startCron, stopCron } from "./cron";

let root: string;
const saved = { d: process.env.EIGHT_DATA_DIR, j: process.env.EIGHT_JOBS_DIR };
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "cronjob-"));
	process.env.EIGHT_DATA_DIR = root;
	process.env.EIGHT_JOBS_DIR = path.join(root, "jobs");
});
afterEach(() => {
	stopCron();
	for (const [k, v] of [
		["EIGHT_DATA_DIR", saved.d],
		["EIGHT_JOBS_DIR", saved.j],
	] as const) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	fs.rmSync(root, { recursive: true, force: true });
});

function job(name: string, payload: string) {
	return {
		id: name,
		name,
		expression: "*/5 * * * *",
		type: "shell",
		payload,
		enabled: true,
		lastRun: new Date(Date.now() - 3_600_000).toISOString(),
		nextRun: null,
		recurring: true,
	};
}
const file = (n: string) => path.join(root, "jobs", `cron-${n}.json`);
const read = (n: string) => JSON.parse(fs.readFileSync(file(n), "utf8"));

test("a cron job row moves from running to done", async () => {
	fs.writeFileSync(path.join(root, "cron.json"), JSON.stringify([job("ok", "sleep 1")]));
	const run = startCron();
	let seen = "";
	for (let i = 0; i < 100 && seen !== "running"; i++) {
		await Bun.sleep(20);
		if (fs.existsSync(file("ok"))) seen = read("ok").state;
	}
	expect(seen).toBe("running");
	await run;
	expect(read("ok").state).toBe("done");
	expect(read("ok").kind).toBe("cron");
});

test("a failing cron job waits on the owner instead of vanishing", async () => {
	fs.writeFileSync(path.join(root, "cron.json"), JSON.stringify([job("bad", "exit 3")]));
	await startCron();
	const r = read("bad");
	expect(r.state).toBe("waiting-on-you");
	expect(r.waitingOn).toContain("exited 3");
});
