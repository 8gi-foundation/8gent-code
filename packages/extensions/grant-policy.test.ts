/**
 * #51 8SO re-read: an outside script cannot ride on a grant, the policy engine
 * is told the truth about approved unattended runs, and the approve-run prompt
 * names the tools that will be called. Real Python child, temp data dir.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadOrCreateKey } from "../permissions/goal-state-hmac";
import { addPolicy, evaluatePolicy } from "../permissions/policy-engine";
import { refreshSecurityEnvForTests } from "../permissions/run-command-sandbox";
import { APPROVAL_KEY, mintApproval, newRunId, resolveProgram } from "./grant";
import { loadAllExtensions } from "./loader";
import { enableExtension, readManifestFile, runExtCli, startProcessExtension } from "./process";

const FIXTURE = path.join(import.meta.dir, "fixtures", "hello");
const yes = async () => true;
const KEYS = ["EIGHT_DATA_DIR", "EIGHT_EXT_APPROVAL", "EIGHT_RUN_ID"] as const;

let root: string;
const saved: Record<string, string | undefined> = {};

function install(name: string, manifest?: Record<string, unknown>): string {
	const dir = path.join(root, name);
	fs.cpSync(FIXTURE, dir, { recursive: true });
	const file = path.join(dir, "manifest.json");
	const m = JSON.parse(fs.readFileSync(file, "utf-8"));
	fs.writeFileSync(file, JSON.stringify({ ...m, name, ...manifest }));
	return dir;
}

beforeEach(() => {
	for (const k of KEYS) saved[k] = process.env[k];
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ext-grant-policy-")));
	process.env.EIGHT_DATA_DIR = path.join(root, ".data");
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

describe("a script outside the folder is never bound by a grant", () => {
	test("an absolute script argument outside the folder is refused at enable", async () => {
		const outside = path.join(root, "outside.py");
		fs.copyFileSync(path.join(FIXTURE, "hello.py"), outside);
		const dir = install("abs", { args: [outside] });
		let asked = false;
		const ask = async () => {
			asked = true;
			return true;
		};
		expect(await enableExtension(dir, "manifest.json", ask)).toBe(false);
		expect(asked).toBe(false);
		expect(fs.existsSync(path.join(dir, ".enabled"))).toBe(false);
	});

	test("an outside script that appears after enabling turns the extension off; nothing runs", async () => {
		const outside = path.join(root, "later.py");
		const marker = path.join(root, "swapped-ran");
		// Enabled while the path names no file, so the grant records no file for it.
		const dir = install("later", { args: [outside] });
		expect(await enableExtension(dir, "manifest.json", yes)).toBe(true);
		fs.writeFileSync(outside, `open(${JSON.stringify(marker)}, "w").close()\n`);
		const [ext] = await loadAllExtensions(root, { attended: true });
		expect(ext.status).toBe("disabled");
		expect(ext.error).toContain("program changed since you enabled it");
		await expect(startProcessExtension(dir, { attended: true })).rejects.toThrow("program changed");
		expect(fs.existsSync(marker)).toBe(false);
	});
});

describe("the policy engine sees approved unattended runs as they are", () => {
	test("an extension_call without run_approved true is treated as not approved", () => {
		const ctx = { server: "x", tool: "t", action: "x/t", attended: false };
		const asked = { allowed: false, requiresApproval: true };
		expect(evaluatePolicy("extension_call", ctx)).toMatchObject(asked);
		expect(evaluatePolicy("extension_call", { ...ctx, run_approved: "true" })).toMatchObject(asked);
		expect(evaluatePolicy("extension_call", { ...ctx, run_approved: true }).allowed).toBe(true);
		expect(evaluatePolicy("extension_call", { ...ctx, attended: true }).allowed).toBe(true);
	});

	test("a rule of your own on unattended calls still blocks an approved run", async () => {
		const dir = install("strict-ext", { permissions: ["tool:hello"] });
		await enableExtension(dir, "manifest.json", yes);
		addPolicy({
			name: "test-no-unattended-strict-ext",
			action: "extension_call",
			condition: "attended equals false and server equals strict-ext",
			decision: "block",
			message: "strict-ext never runs unattended",
		});
		const grant = readManifestFile(dir, "manifest.json")?.grant;
		if (grant?.state !== "ok") throw new Error("not enabled");
		const run = newRunId();
		const env = {
			EIGHT_RUN_ID: run,
			EIGHT_EXT_APPROVAL: mintApproval(
				{ ext: "strict-ext", grant: grant.hash, run },
				loadOrCreateKey(APPROVAL_KEY),
			),
		};
		// Approved: it starts, but the call is refused by the person's own rule.
		const ext = await startProcessExtension(dir, { attended: false, env });
		try {
			const out = await ext.tools.hello();
			expect(out).toContain("refused by policy");
			expect(out).toContain("strict-ext never runs unattended");
		} finally {
			ext.close();
		}
		// The same extension with a person at the keyboard is not caught by that rule.
		const attended = await startProcessExtension(dir, { attended: true });
		try {
			expect(await attended.tools.hello()).toBe("hello world");
		} finally {
			attended.close();
		}
	});
});

describe("approve-run names what will be called", () => {
	test("the prompt lists the declared tools and the resolved program", async () => {
		const dir = install("named", { permissions: ["tool:hello", "tool:pid"] });
		await enableExtension(dir, "manifest.json", yes);
		let question = "";
		await runExtCli(["approve-run", "named"], {
			root,
			ask: async (q) => {
				question = q;
				return false;
			},
			log: () => {},
		});
		expect(question).toContain('its tools ["hello","pid"] will be called without asking');
		expect(question).toContain(JSON.stringify(resolveProgram(dir, "python3")));
	});

	test("tool:* is said in words", async () => {
		const dir = install("star", { permissions: ["tool:*"] });
		await enableExtension(dir, "manifest.json", yes);
		let question = "";
		await runExtCli(["approve-run", "star"], {
			root,
			ask: async (q) => {
				question = q;
				return false;
			},
			log: () => {},
		});
		expect(question).toContain('["every tool it offers"]');
	});
});
