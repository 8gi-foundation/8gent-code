/**
 * Revertible extension scope (#3431). Every tool, listener and deferred undo
 * an extension registers through its scope is recorded with its undo, so
 * unload leaves nothing behind and reload is unload plus load. Hooks are not
 * part of the scope yet (HookManager persists them to disk).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createExtensionManager } from "./index";
import { collectExtensionTools, loadExtension } from "./loader";
import { createScope } from "./scope";

const bus = new EventEmitter();
const g = globalThis as Record<string, unknown>;
g.__extScopeTestBus = bus;
/** Live resources the fixture opens with scope.defer; must return to 0. */
const live = { count: 0 };
g.__extScopeTestLive = live;

const ENTRY = (version: number) => `
export function ping() { return "manifest-tool"; }
export async function activate(scope) {
	scope.tool("echo", () => "v${version}");
	globalThis.__extScopeTestLive.count++;
	scope.defer(() => { globalThis.__extScopeTestLive.count--; });
	scope.listen(globalThis.__extScopeTestBus, "msg", () => {});
}
`;

let root: string;
let prevFlag: string | undefined;

function writeExt(name: string, version: number): string {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "8gent-extension.json"),
		JSON.stringify({
			name,
			version: `${version}.0.0`,
			description: "fixture",
			entry: "index.js",
			tools: [{ name: "ping", description: "ping", parameters: {} }],
		}),
	);
	fs.writeFileSync(path.join(dir, "index.js"), ENTRY(version));
	return dir;
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-scope-"));
	prevFlag = process.env.EIGHT_EXT_SCOPE;
	bus.removeAllListeners();
	live.count = 0;
});

afterEach(() => {
	if (prevFlag === undefined) delete process.env.EIGHT_EXT_SCOPE;
	else process.env.EIGHT_EXT_SCOPE = prevFlag;
	fs.rmSync(root, { recursive: true, force: true });
});

describe("extension scope (EIGHT_EXT_SCOPE=1)", () => {
	beforeEach(() => {
		process.env.EIGHT_EXT_SCOPE = "1";
	});

	test("unload removes the tool, the listener and the deferred resource", async () => {
		const mgr = createExtensionManager({ dir: root });
		writeExt("alpha", 1);
		writeExt("beta", 1);
		await mgr.loadAll();

		expect(mgr.getTools()["alpha:echo"]?.()).toBe("v1");
		expect(live.count).toBe(2);
		expect(bus.listenerCount("msg")).toBe(2);

		const res = await mgr.unload("alpha");
		expect(res.errors).toEqual([]);

		const tools = mgr.getTools();
		expect(Object.keys(tools).filter((k) => k.startsWith("alpha:"))).toEqual([]);
		expect(mgr.extensions.map((e) => e.manifest.name)).toEqual(["beta"]);
		// Only beta's registrations remain.
		expect(live.count).toBe(1);
		expect(bus.listenerCount("msg")).toBe(1);
		expect(tools["beta:echo"]?.()).toBe("v1");
	});

	test("reload gives exactly one of each and picks up edits", async () => {
		const mgr = createExtensionManager({ dir: root });
		const dir = writeExt("alpha", 1);
		await mgr.loadAll();

		fs.writeFileSync(path.join(dir, "index.js"), ENTRY(2));
		const res = await mgr.reload("alpha");
		expect(res.errors).toEqual([]);

		const tools = mgr.getTools();
		expect(Object.keys(tools).filter((k) => k === "alpha:echo")).toHaveLength(1);
		expect(tools["alpha:echo"]?.()).toBe("v2");
		expect(live.count).toBe(1);
		expect(bus.listenerCount("msg")).toBe(1);
		expect(mgr.extensions.filter((e) => e.manifest.name === "alpha")).toHaveLength(1);
	});

	test("a throwing undo does not stop the rest, and is reported", async () => {
		const scope = createScope("gamma");
		const ran: string[] = [];
		scope.defer(() => ran.push("first"));
		scope.defer(() => {
			throw new Error("boom");
		});
		scope.defer(() => ran.push("third"));

		const res = await scope.dispose();
		// Undos run newest first; the throw sits between the other two.
		expect(ran).toEqual(["third", "first"]);
		expect(res.errors).toHaveLength(1);
		expect(res.errors[0]).toContain("gamma");
		expect(res.errors[0]).toContain("boom");

		// Disposing twice is a no-op.
		expect((await scope.dispose()).errors).toEqual([]);
	});

	test("unload of an unknown extension reports, does not throw", async () => {
		const mgr = createExtensionManager({ dir: root });
		const res = await mgr.unload("nope");
		expect(res.errors[0]).toContain("not loaded");
	});
});

describe("flag off (default)", () => {
	beforeEach(() => {
		delete process.env.EIGHT_EXT_SCOPE;
	});

	test("loader does not call activate and gives no scope", async () => {
		writeExt("alpha", 1);
		const ext = await loadExtension(path.join(root, "alpha"));
		expect(ext.status).toBe("loaded");
		expect(ext.scope).toBeUndefined();
		expect(bus.listenerCount("msg")).toBe(0);

		const tools = collectExtensionTools([ext]);
		expect(Object.keys(tools)).toEqual(["alpha:ping"]);
		expect(tools["alpha:ping"]?.()).toBe("manifest-tool");
	});

	test("manager unload and reload refuse without touching anything", async () => {
		const mgr = createExtensionManager({ dir: root });
		writeExt("alpha", 1);
		await mgr.loadAll();
		expect(Object.keys(mgr.getTools())).toEqual(["alpha:ping"]);
		expect(live.count).toBe(0);

		const res = await mgr.unload("alpha");
		expect(res.errors[0]).toContain("EIGHT_EXT_SCOPE");
		expect(mgr.extensions).toHaveLength(1);
		expect((await mgr.reload("alpha")).errors[0]).toContain("EIGHT_EXT_SCOPE");
	});
});
