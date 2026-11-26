/**
 * #47: the grant binds the program, unattended runs need a per-run approval,
 * and children go when the host is signalled. Real Python children; nothing
 * on the spawn or call path is stubbed. Keys live in a temp data dir.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { refreshSecurityEnvForTests } from "../permissions/run-command-sandbox";
import { APPROVAL_KEY, mintApproval, newRunId, resolveProgram, verifyApproval } from "./grant";
import { loadAllExtensions } from "./loader";
import { enableExtension, readManifestFile, runExtCli, startProcessExtension } from "./process";

const FIXTURE = path.join(import.meta.dir, "fixtures", "hello");
const yes = async () => true;
const no = async () => false;
const KEYS = ["EIGHT_DATA_DIR", "EIGHT_EXT_APPROVAL", "EIGHT_RUN_ID", "PATH"] as const;

let root: string;
let data: string;
const saved: Record<string, string | undefined> = {};

function install(name = "hello"): string {
	const dir = path.join(root, name);
	fs.cpSync(FIXTURE, dir, { recursive: true });
	return dir;
}

const started = (dir: string) => fs.existsSync(path.join(dir, "started"));
const grantHashOf = (dir: string) => {
	const g = readManifestFile(dir, "manifest.json")?.grant;
	if (g?.state !== "ok") throw new Error(`grant is ${g?.state}`);
	return g.hash;
};
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

beforeEach(() => {
	for (const k of KEYS) saved[k] = process.env[k];
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ext-grant-")));
	data = path.join(root, ".data");
	process.env.EIGHT_DATA_DIR = data;
	Reflect.deleteProperty(process.env, "EIGHT_EXT_APPROVAL");
	Reflect.deleteProperty(process.env, "EIGHT_RUN_ID");
	refreshSecurityEnvForTests();
});
afterEach(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = saved[k];
	}
	refreshSecurityEnvForTests();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("the grant binds the program", () => {
	test("editing the script after enabling turns it off and starts nothing", async () => {
		const dir = install();
		expect(await enableExtension(dir, "manifest.json", yes)).toBe(true);
		const grant = JSON.parse(fs.readFileSync(path.join(dir, ".enabled"), "utf-8"));
		expect(Object.keys(grant.files)).toEqual(["hello.py"]);
		expect(path.isAbsolute(grant.program.path)).toBe(true);

		fs.appendFileSync(path.join(dir, "hello.py"), "\n# changed by a pull\n");
		const [ext] = await loadAllExtensions(root, { attended: true });
		expect(ext.status).toBe("disabled");
		expect(ext.error).toBe(
			"program changed since you enabled it; run 8gent ext enable hello to review",
		);
		await expect(startProcessExtension(dir, { attended: true })).rejects.toThrow(
			"program changed since you enabled it",
		);
		expect(started(dir)).toBe(false);

		// Enabling again records the new bytes and it runs.
		expect(await enableExtension(dir, "manifest.json", yes)).toBe(true);
		const [again] = await loadAllExtensions(root, { attended: true });
		try {
			expect(again.status).toBe("loaded");
		} finally {
			again.close?.();
		}
	});

	test("a grant from before program checks is not honoured", async () => {
		const dir = install();
		const { createHash } = await import("node:crypto");
		const bytes = fs.readFileSync(path.join(dir, "manifest.json"));
		fs.writeFileSync(path.join(dir, ".enabled"), createHash("sha256").update(bytes).digest("hex"));
		const [ext] = await loadAllExtensions(root, { attended: true });
		expect(ext.status).toBe("disabled");
		expect(ext.error).toContain("enabled before program checks; run 8gent ext enable hello");
		expect(started(dir)).toBe(false);
	});

	test("a swapped or re-ordered PATH interpreter turns it off", async () => {
		const real = resolveProgram(root, "python3", saved.PATH);
		const binA = path.join(root, "binA");
		const binB = path.join(root, "binB");
		fs.mkdirSync(binA);
		fs.mkdirSync(binB);
		const wrapper = `#!/bin/sh\nexec ${JSON.stringify(real)} "$@"\n`;
		fs.writeFileSync(path.join(binA, "python3"), wrapper, { mode: 0o755 });
		process.env.PATH = `${binA}${path.delimiter}${saved.PATH}`;

		const dir = install();
		expect(await enableExtension(dir, "manifest.json", yes)).toBe(true);
		const grant = JSON.parse(fs.readFileSync(path.join(dir, ".enabled"), "utf-8"));
		expect(grant.program.path).toBe(path.join(binA, "python3"));

		// Same path, different bytes.
		fs.writeFileSync(path.join(binA, "python3"), `${wrapper}# swapped\n`, { mode: 0o755 });
		let [ext] = await loadAllExtensions(root, { attended: true });
		expect(ext.status).toBe("disabled");
		expect(ext.error).toContain("program changed");
		expect(started(dir)).toBe(false);

		// Same bytes, but another python3 now comes first on PATH.
		fs.writeFileSync(path.join(binA, "python3"), wrapper, { mode: 0o755 });
		fs.writeFileSync(path.join(binB, "python3"), wrapper, { mode: 0o755 });
		process.env.PATH = `${binB}${path.delimiter}${binA}${path.delimiter}${saved.PATH}`;
		[ext] = await loadAllExtensions(root, { attended: true });
		expect(ext.status).toBe("disabled");
		expect(ext.error).toContain("program changed");
		expect(started(dir)).toBe(false);

		// Back as granted: it runs, from the recorded absolute path.
		process.env.PATH = `${binA}${path.delimiter}${saved.PATH}`;
		[ext] = await loadAllExtensions(root, { attended: true });
		try {
			expect(ext.status).toBe("loaded");
			expect(started(dir)).toBe(true);
		} finally {
			ext.close?.();
		}
	});

	test("a relative PATH entry is never searched", () => {
		const cwdBin = path.join(root, "cwdbin");
		fs.mkdirSync(cwdBin);
		fs.writeFileSync(path.join(cwdBin, "planted"), "#!/bin/sh\n", { mode: 0o755 });
		const before = process.cwd();
		process.chdir(cwdBin);
		try {
			expect(() => resolveProgram(root, "planted", `.${path.delimiter}`)).toThrow("not found");
		} finally {
			process.chdir(before);
		}
	});
});

describe("per-run approval for unattended runs", () => {
	async function approved(dir: string, opts: { ttlMs?: number; now?: number; key?: Buffer } = {}) {
		await enableExtension(dir, "manifest.json", yes);
		const { loadOrCreateKey } = await import("../permissions/goal-state-hmac");
		const run = newRunId();
		const token = mintApproval(
			{ ext: path.basename(dir), grant: grantHashOf(dir), run, ...opts },
			opts.key ?? loadOrCreateKey(APPROVAL_KEY),
		);
		return { run, token };
	}

	test("unattended without a token starts nothing", async () => {
		const dir = install();
		await enableExtension(dir, "manifest.json", yes);
		const [ext] = await loadAllExtensions(root, { attended: false });
		expect(ext.status).toBe("disabled");
		expect(ext.error).toBe("disabled (unattended)");
		await expect(startProcessExtension(dir, { attended: false })).rejects.toThrow("unattended");
		expect(started(dir)).toBe(false);
	});

	test("a valid token starts it once, unattended, and its tools pass the gate", async () => {
		const dir = install();
		const { run, token } = await approved(dir);
		process.env.EIGHT_RUN_ID = run;
		process.env.EIGHT_EXT_APPROVAL = token;
		const [ext] = await loadAllExtensions(root, { attended: false });
		try {
			expect(ext.status).toBe("loaded");
			expect(started(dir)).toBe(true);
			const tools = ext.module.tools as unknown as Record<string, () => Promise<string>>;
			expect(await tools.hello()).toBe("hello world");
		} finally {
			ext.close?.();
		}
		// The key is the person's, created 0600.
		const st = fs.statSync(path.join(data, "keys", APPROVAL_KEY));
		expect(st.mode & 0o777).toBe(0o600);
	});

	test("an expired token starts nothing", async () => {
		const dir = install();
		const { run, token } = await approved(dir, { ttlMs: 60_000, now: Date.now() - 120_000 });
		process.env.EIGHT_RUN_ID = run;
		process.env.EIGHT_EXT_APPROVAL = token;
		const [ext] = await loadAllExtensions(root, { attended: false });
		expect(ext.status).toBe("disabled");
		expect(ext.error).toBe("disabled (unattended): approval has expired");
		expect(started(dir)).toBe(false);
	});

	test("a token signed with another key, or edited, starts nothing", async () => {
		const dir = install();
		// Make sure the device key exists, so the refusal is the signature, not a missing key.
		const { loadOrCreateKey } = await import("../permissions/goal-state-hmac");
		loadOrCreateKey(APPROVAL_KEY);
		const forged = await approved(dir, { key: randomBytes(32) });
		process.env.EIGHT_RUN_ID = forged.run;
		process.env.EIGHT_EXT_APPROVAL = forged.token;
		let [ext] = await loadAllExtensions(root, { attended: false });
		expect(ext.error).toBe("disabled (unattended): approval signature is not valid");

		// A real token with its payload rewritten (longer expiry) keeps the old signature.
		const real = await approved(dir);
		const [body, sig] = real.token.split(".");
		const p = JSON.parse(Buffer.from(body, "base64url").toString());
		p.exp += 86_400_000;
		process.env.EIGHT_RUN_ID = real.run;
		process.env.EIGHT_EXT_APPROVAL = `${Buffer.from(JSON.stringify(p)).toString("base64url")}.${sig}`;
		[ext] = await loadAllExtensions(root, { attended: false });
		expect(ext.status).toBe("disabled");
		expect(ext.error).toBe("disabled (unattended): approval signature is not valid");
		expect(started(dir)).toBe(false);
	});

	test("a token for another run, or for the program before it changed, starts nothing", async () => {
		const dir = install();
		const { run, token } = await approved(dir);
		process.env.EIGHT_EXT_APPROVAL = token;
		process.env.EIGHT_RUN_ID = newRunId();
		let [ext] = await loadAllExtensions(root, { attended: false });
		expect(ext.error).toBe("disabled (unattended): approval is for a different run (EIGHT_RUN_ID)");

		// Program edited and re-enabled after approval: the old token names the old grant.
		process.env.EIGHT_RUN_ID = run;
		fs.appendFileSync(path.join(dir, "hello.py"), "\n# new\n");
		await enableExtension(dir, "manifest.json", yes);
		[ext] = await loadAllExtensions(root, { attended: false });
		expect(ext.error).toBe("disabled (unattended): approval was for a different program");
		expect(started(dir)).toBe(false);
	});

	test("one run id belongs to one process", async () => {
		const dir = install();
		const { run, token } = await approved(dir);
		const env = { EIGHT_RUN_ID: run, EIGHT_EXT_APPROVAL: token };
		const grant = grantHashOf(dir);
		expect(verifyApproval("hello", grant, { env, pid: 111 })).toEqual({ ok: true });
		// The same process again (a reload) is fine; another process is not.
		expect(verifyApproval("hello", grant, { env, pid: 111 })).toEqual({ ok: true });
		expect(verifyApproval("hello", grant, { env, pid: 222 })).toEqual({
			ok: false,
			reason: "approval was already used by another run",
		});
	});

	test("no key on the device means no approval, and verifying never creates one", async () => {
		const dir = install();
		await enableExtension(dir, "manifest.json", yes);
		const env = { EIGHT_RUN_ID: newRunId(), EIGHT_EXT_APPROVAL: "a.b" };
		expect(verifyApproval("hello", grantHashOf(dir), { env })).toEqual({
			ok: false,
			reason: "no approval key on this device",
		});
		expect(fs.existsSync(path.join(data, "keys", APPROVAL_KEY))).toBe(false);
	});
});

describe("8gent ext approve-run", () => {
	test("asks, default No: a No makes no key and no token", async () => {
		install();
		const dir = path.join(root, "hello");
		await enableExtension(dir, "manifest.json", yes);
		const out: string[] = [];
		expect(
			await runExtCli(["approve-run", "hello"], { root, ask: no, log: (l) => out.push(l) }),
		).toBe(1);
		expect(out).toEqual(["not approved"]);
		expect(fs.existsSync(path.join(data, "keys", APPROVAL_KEY))).toBe(false);
	});

	test("the default prompt says No with nobody at a terminal", async () => {
		install();
		await enableExtension(path.join(root, "hello"), "manifest.json", yes);
		const out: string[] = [];
		// bun test has no TTY: promptDefaultNo answers No without asking.
		expect(await runExtCli(["approve-run", "hello"], { root, log: (l) => out.push(l) })).toBe(1);
		expect(fs.existsSync(path.join(data, "keys", APPROVAL_KEY))).toBe(false);
	});

	test("a Yes prints a run id and token that start it unattended", async () => {
		const dir = install();
		await enableExtension(dir, "manifest.json", yes);
		const out: string[] = [];
		let question = "";
		const ask = async (q: string) => {
			question = q;
			return true;
		};
		const code = await runExtCli(["approve-run", "hello", "--ttl", "30m"], {
			root,
			ask,
			log: (l) => out.push(l),
		});
		expect(code).toBe(0);
		expect(question).toContain("within 30 min");
		const env = Object.fromEntries(
			out.filter((l) => l.startsWith("EIGHT_")).map((l) => l.split(/=(.*)/s).slice(0, 2)),
		);
		process.env.EIGHT_RUN_ID = env.EIGHT_RUN_ID;
		process.env.EIGHT_EXT_APPROVAL = env.EIGHT_EXT_APPROVAL;
		const [ext] = await loadAllExtensions(root, { attended: false });
		try {
			expect(ext.status).toBe("loaded");
		} finally {
			ext.close?.();
		}
	});

	test("refuses names that are paths, extensions not enabled, and bad durations", async () => {
		install();
		const out: string[] = [];
		const log = (l: string) => out.push(l);
		expect(await runExtCli(["approve-run", "../x"], { root, ask: yes, log })).toBe(2);
		expect(await runExtCli(["approve-run", "hello"], { root, ask: yes, log })).toBe(1);
		expect(out.at(-1)).toBe("not enabled; run 8gent ext enable hello first");
		expect(await runExtCli(["approve-run", "hello", "--ttl", "25h"], { root, ask: yes, log })).toBe(
			2,
		);
		expect(await runExtCli(["frobnicate", "hello"], { root, ask: yes, log })).toBe(2);
	});
});

describe("signal cleanup", () => {
	for (const sig of ["SIGTERM", "SIGINT"] as const) {
		test(`${sig} to the host takes the child with it`, async () => {
			const dir = install();
			await enableExtension(dir, "manifest.json", yes);
			const script = path.join(root, "host.ts");
			fs.writeFileSync(
				script,
				`import { startProcessExtension } from ${JSON.stringify(path.join(import.meta.dir, "process"))};
const ext = await startProcessExtension(${JSON.stringify(dir)}, { attended: true });
console.log(await ext.tools.pid());
setInterval(() => {}, 1000);`,
			);
			const host = Bun.spawn({ cmd: [process.execPath, "run", script], stdout: "pipe" });
			const reader = host.stdout.getReader();
			let line = "";
			while (!line.includes("\n")) {
				const { value, done } = await reader.read();
				if (done) break;
				line += new TextDecoder().decode(value);
			}
			const pid = Number(line.trim());
			expect(pid).toBeGreaterThan(1);
			expect(alive(pid)).toBe(true);
			host.kill(sig);
			await host.exited;
			// The host still ends the way the signal says: our handler re-raises it.
			expect(host.signalCode).toBe(sig);
			for (let i = 0; i < 40 && alive(pid); i++) await Bun.sleep(50);
			expect(alive(pid)).toBe(false);
		});
	}

	test("closing the last child removes the signal handlers", async () => {
		const before = process.listenerCount("SIGTERM");
		const dir = install();
		await enableExtension(dir, "manifest.json", yes);
		const ext = await startProcessExtension(dir, { attended: true });
		expect(process.listenerCount("SIGTERM")).toBe(before + 1);
		ext.close();
		expect(process.listenerCount("SIGTERM")).toBe(before);
	});
});
