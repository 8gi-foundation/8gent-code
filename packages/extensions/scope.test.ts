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

function writeExt(name: string, version: number, entry = ENTRY(version)): string {
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
	fs.writeFileSync(path.join(dir, "index.js"), entry);
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

	test("registrations after unload are refused (timer fires late)", async () => {
		const mgr = createExtensionManager({ dir: root });
		writeExt(
			"late",
			1,
			`export function activate(scope) {
				setTimeout(() => {
					try { scope.listen(globalThis.__extScopeTestBus, "msg", () => {}); }
					catch (e) { globalThis.__extScopeLate = String(e.message); }
				}, 20);
			}`,
		);
		await mgr.loadAll();
		expect((await mgr.unload("late")).errors).toEqual([]);
		await Bun.sleep(60);
		expect(bus.listenerCount("msg")).toBe(0);
		expect(String(g.__extScopeLate)).toContain("disposed");
	});

	test("a hanging activate times out, is rolled back, and does not block the rest", async () => {
		const mgr = createExtensionManager({ dir: root, activateTimeoutMs: 50 });
		writeExt("alpha", 1);
		writeExt(
			"hang",
			1,
			`export function activate(scope) {
				scope.listen(globalThis.__extScopeTestBus, "msg", () => {});
				return new Promise(() => {});
			}`,
		);
		const loaded = await mgr.loadAll();
		const hang = loaded.find((e) => e.manifest.name === "hang");
		expect(hang?.status).toBe("error");
		expect(hang?.error).toContain("timed out");
		expect(loaded.find((e) => e.manifest.name === "alpha")?.status).toBe("loaded");
		// Only alpha's listener is left; hang's was undone on timeout.
		expect(bus.listenerCount("msg")).toBe(1);
		expect(mgr.getTools()["alpha:echo"]?.()).toBe("v1");
	});

	test("activate that throws rolls back what it registered", async () => {
		writeExt(
			"broken",
			1,
			`export function activate(scope) {
				scope.tool("t", () => 1);
				globalThis.__extScopeTestLive.count++;
				scope.defer(() => { globalThis.__extScopeTestLive.count--; });
				scope.listen(globalThis.__extScopeTestBus, "msg", () => {});
				throw new Error("kaboom");
			}`,
		);
		const ext = await loadExtension(path.join(root, "broken"));
		expect(ext.status).toBe("error");
		expect(ext.error).toContain("kaboom");
		expect(ext.scope).toBeUndefined();
		expect(bus.listenerCount("msg")).toBe(0);
		expect(live.count).toBe(0);
		expect(collectExtensionTools([ext])).toEqual({});
	});

	test("listen refuses an emitter it could not unsubscribe from", () => {
		const scope = createScope("noff");
		let subscribed = 0;
		const emitter = { on: () => subscribed++ };
		expect(() => scope.listen(emitter, "msg", () => {})).toThrow(/off/);
		expect(subscribed).toBe(0);
	});

	test("tool names are validated, so __proto__ cannot be registered", () => {
		const scope = createScope("names");
		expect(() => scope.tool("__proto__", () => 1)).toThrow(/tool name/);
		expect(() => scope.tool("a b", () => 1)).toThrow(/tool name/);
		scope.tool("ok-name_1", () => 1);
		expect(Object.keys(scope.tools)).toEqual(["ok-name_1"]);
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
