import { afterEach, describe, expect, it } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findNodeBinary } from "./find-node.js";
import { checkNodePty, ptyFixLine, resetPtyCheck } from "./pty-available.js";

afterEach(() => {
	resetPtyCheck();
	process.env.NODE_8GENT_BIN = saved ?? "";
	if (saved === undefined) Reflect.deleteProperty(process.env, "NODE_8GENT_BIN");
});
const saved = process.env.NODE_8GENT_BIN;

describe("checkNodePty", () => {
	it.if(Boolean(findNodeBinary()))("matches what the bridge would do on this machine", () => {
		const r = checkNodePty(process.cwd(), true);
		// Either answer is honest; a failure must carry a reason for the message.
		if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
		expect(checkNodePty()).toBe(checkNodePty()); // cached
	});
	it("reports no Node runtime when none can be found", () => {
		process.env.NODE_8GENT_BIN = "/nonexistent/node";
		const oldPath = process.env.PATH;
		const oldExec = process.execPath;
		process.env.PATH = "/nonexistent";
		try {
			const r = checkNodePty("/", true);
			if (!/\/node$/.test(oldExec))
				expect(r).toEqual({ ok: false, reason: "no Node runtime found" });
		} finally {
			process.env.PATH = oldPath;
		}
	});
});

describe("checkNodePty when node-pty cannot load", () => {
	it.if(Boolean(findNodeBinary()))(
		"says not ok with a reason (bridge copied outside the repo)",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "8gent-no-pty-check-"));
			try {
				const bridge = join(dir, "pty-bridge.cjs");
				copyFileSync(join(import.meta.dir, "pty-bridge.cjs"), bridge);
				const r = checkNodePty(dir, true, bridge);
				expect(r.ok).toBe(false);
				if (!r.ok) expect(r.reason).toContain("node-pty");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});

describe("ptyFixLine", () => {
	it("gives the Termux fix on Android in one line, rebuilding inside the global install", () => {
		const l = ptyFixLine("linux", { TERMUX_VERSION: "0.118" });
		expect(l).toContain("pkg install python make clang");
		expect(l).toContain('cd "$(npm root -g)/@8gi-foundation/8gent-code"');
		expect(l).toContain("npm rebuild node-pty");
		expect(l).not.toContain("\n");
	});
	it("gives the generic fix elsewhere", () => {
		expect(ptyFixLine("linux", {})).toContain("npm rebuild node-pty");
		expect(ptyFixLine("linux", {})).not.toContain("pkg install");
	});
});
