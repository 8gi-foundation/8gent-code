/**
 * Out-of-process extensions (#44): spawn, handshake, tools, policy, crash, exit.
 * The fixture is a real Python child; nothing here is stubbed on the call path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addPolicy } from "../permissions/policy-engine";
import { collectExtensionTools, loadAllExtensions } from "./loader";
import { enableExtension, startProcessExtension } from "./process";

const FIXTURE = path.join(import.meta.dir, "fixtures", "hello");
const yes = async () => true;
const no = async () => false;

let root: string;

/** Copy the fixture under another name so the repo copy is never written to. */
function install(name = "hello", permissions?: string[]): string {
	const dir = path.join(root, name);
	fs.cpSync(FIXTURE, dir, { recursive: true });
	const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf-8"));
	fs.writeFileSync(
		path.join(dir, "manifest.json"),
		JSON.stringify({ ...m, name, ...(permissions ? { permissions } : {}) }),
	);
	return dir;
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-oop-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("disabled by default", () => {
	test("an installed extension is not started until enabled", async () => {
		install();
		const [ext] = await loadAllExtensions(root);
		expect(ext.status).toBe("disabled");
		expect(collectExtensionTools([ext])).toEqual({});
		await expect(startProcessExtension(path.join(root, "hello"))).rejects.toThrow("disabled");
	});

	test("the prompt answering No, or no terminal, leaves it off", async () => {
		const dir = install();
		expect(await enableExtension(dir, "manifest.json", no)).toBe(false);
		// bun test has no TTY: the default prompt must also say no.
		expect(await enableExtension(dir)).toBe(false);
		expect(fs.existsSync(path.join(dir, ".enabled"))).toBe(false);
	});

	test("editing the manifest after enabling turns it off again", async () => {
		const dir = install();
		expect(await enableExtension(dir, "manifest.json", yes)).toBe(true);
		const file = path.join(dir, "manifest.json");
		fs.writeFileSync(file, fs.readFileSync(file, "utf-8").replace("0.1.0", "0.2.0"));
		const [ext] = await loadAllExtensions(root);
		expect(ext.status).toBe("disabled");
	});

	test("in-process modules are also off until enabled", async () => {
		const dir = path.join(root, "legacy");
		fs.mkdirSync(dir);
		fs.writeFileSync(
			path.join(dir, "8gent-extension.json"),
			JSON.stringify({ name: "legacy", version: "1", description: "d", entry: "i.js" }),
		);
		fs.writeFileSync(path.join(dir, "i.js"), "globalThis.__legacyRan = true;");
		const [ext] = await loadAllExtensions(root);
		expect(ext.status).toBe("disabled");
		expect((globalThis as Record<string, unknown>).__legacyRan).toBeUndefined();
	});
});

describe("enabled extension", () => {
	test("spawn, handshake, list tools, call through the gate", async () => {
		const dir = install();
		await enableExtension(dir, "manifest.json", yes);
		const [ext] = await loadAllExtensions(root);
		try {
			// bun test has no terminal, so the default policy refuses until a person is present.
			expect(await collectExtensionTools([ext])["hello:hello"]()).toContain("needs a person");
		} finally {
			ext.close?.();
		}
		const live = await startProcessExtension(dir, { attended: true });
		try {
			expect(Object.keys(live.tools).sort()).toEqual(["crash", "hello", "pid", "undeclared"]);
			expect(await live.tools.hello({ who: "Rishi" })).toBe("hello Rishi");
		} finally {
			live.close();
		}
	});

	test("a tool the manifest does not declare is denied before the child sees it", async () => {
		const dir = install();
		await enableExtension(dir, "manifest.json", yes);
		const ext = await startProcessExtension(dir, { attended: true });
		try {
			const out = await ext.tools.undeclared();
			expect(out).toContain("[BLOCKED]");
			expect(out).toContain("not in the permissions");
		} finally {
			ext.close();
		}
	});

	test("a policy block on extension_call denies a declared tool", async () => {
		const dir = install("blocked-ext");
		await enableExtension(dir, "manifest.json", yes);
		addPolicy({
			name: "test-block-blocked-ext",
			action: "extension_call",
			condition: "server equals blocked-ext",
			decision: "block",
			message: "blocked-ext is off",
		});
		const ext = await startProcessExtension(dir, { attended: true });
		try {
			const out = await ext.tools.hello({ who: "x" });
			expect(out).toContain("refused by policy");
			expect(out).toContain("blocked-ext is off");
		} finally {
			ext.close();
		}
	});

	test("a child crash fails the call, not the host, and the next call fails cleanly", async () => {
		const dir = install();
		await enableExtension(dir, "manifest.json", yes);
		const ext = await startProcessExtension(dir, { attended: true });
		try {
			expect(await ext.tools.crash()).toContain("stopped");
			expect(await ext.tools.hello()).toContain("stopped");
		} finally {
			ext.close();
		}
	});

	test("the child is killed when the host exits", async () => {
		const dir = install();
		await enableExtension(dir, "manifest.json", yes);
		const script = path.join(root, "host.ts");
		fs.writeFileSync(
			script,
			`import { startProcessExtension } from ${JSON.stringify(path.join(import.meta.dir, "process"))};
const ext = await startProcessExtension(${JSON.stringify(dir)}, { attended: true });
console.log(await ext.tools.pid());
process.exit(0);`,
		);
		const host = Bun.spawn({ cmd: [process.execPath, "run", script], stdout: "pipe" });
		const pid = Number((await new Response(host.stdout).text()).trim());
		await host.exited;
		expect(pid).toBeGreaterThan(1);
		for (let i = 0; i < 40 && alive(pid); i++) await Bun.sleep(50);
		expect(alive(pid)).toBe(false);
	});
});
