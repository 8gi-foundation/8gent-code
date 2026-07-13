/**
 * Capability manifest enforcement tests (issue #2756 step 1).
 *
 * The done-criterion of the epic in miniature: a tool scoped to the
 * workspace cannot read ~/.ssh even if it tries, whether it tries with a
 * relative escape, an absolute path, or a symlink.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type CapabilityRequest,
	enforceCapability,
	getToolManifest,
	registerToolManifest,
	resetToolManifests,
} from "./capability-manifest";
import { evaluateToolCall } from "./policy-engine";

// Real on-disk workspace so realpathSync has something to canonicalise.
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "cap-workspace-"));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), "cap-outside-"));

// Fake home with a fake SSH key - the target every escape attempt aims at.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cap-home-"));
const SSH_DIR = path.join(FAKE_HOME, ".ssh");
const SSH_KEY = path.join(SSH_DIR, "id_ed25519");

let symlinksSupported = true;
const SYMLINK_OUT = path.join(WORKSPACE, "escape-link");

beforeAll(() => {
	fs.writeFileSync(path.join(WORKSPACE, "hello.txt"), "hi");
	fs.mkdirSync(path.join(WORKSPACE, "src"), { recursive: true });
	fs.writeFileSync(path.join(WORKSPACE, "src", "main.ts"), "export {}");
	fs.writeFileSync(path.join(OUTSIDE, "secret.txt"), "supersecret");
	fs.mkdirSync(SSH_DIR, { recursive: true });
	fs.writeFileSync(SSH_KEY, "PRIVATE KEY MATERIAL");
	try {
		fs.symlinkSync(OUTSIDE, SYMLINK_OUT);
	} catch {
		symlinksSupported = false;
	}
	process.env.EIGHT_FAKE_HOME = FAKE_HOME;
});

afterAll(() => {
	delete process.env.EIGHT_FAKE_HOME;
	for (const dir of [WORKSPACE, OUTSIDE, FAKE_HOME]) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

afterEach(() => {
	resetToolManifests();
});

const opts = { workingDirectory: WORKSPACE };

function read(p: string): CapabilityRequest {
	return { kind: "fs_read", path: p };
}
function write(p: string): CapabilityRequest {
	return { kind: "fs_write", path: p };
}

// ============================================
// Deny by default
// ============================================

describe("deny by default", () => {
	test("a tool with no manifest gets nothing", () => {
		const decision = enforceCapability(
			"mystery_tool",
			read(path.join(WORKSPACE, "hello.txt")),
			opts,
		);
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) {
			expect(decision.requiresApproval).toBe(true);
			expect(decision.reason).toContain("no capability manifest");
		}
	});

	test("a manifest without the requested capability is a denial", () => {
		// read_file declares fs.read only - no write, no network, no exec
		expect(enforceCapability("read_file", write(path.join(WORKSPACE, "x.txt")), opts).allowed).toBe(
			false,
		);
		expect(
			enforceCapability("read_file", { kind: "network", url: "https://example.com" }, opts).allowed,
		).toBe(false);
		expect(enforceCapability("read_file", { kind: "exec", command: "ls" }, opts).allowed).toBe(
			false,
		);
	});
});

// ============================================
// Filesystem scoping
// ============================================

describe("fs scoping", () => {
	test("read inside the workspace is allowed", () => {
		expect(
			enforceCapability("read_file", read(path.join(WORKSPACE, "hello.txt")), opts).allowed,
		).toBe(true);
		expect(enforceCapability("read_file", read("src/main.ts"), opts).allowed).toBe(true);
	});

	test("relative ../ escape is denied", () => {
		const escape = path.join(WORKSPACE, "..", path.basename(OUTSIDE), "secret.txt");
		expect(enforceCapability("read_file", read(escape), opts).allowed).toBe(false);
	});

	test("absolute path outside the workspace is denied", () => {
		expect(
			enforceCapability("read_file", read(path.join(OUTSIDE, "secret.txt")), opts).allowed,
		).toBe(false);
	});

	test("the epic's done-criterion: workspace tool cannot read ~/.ssh", () => {
		const decision = enforceCapability("read_file", read(SSH_KEY), opts);
		expect(decision.allowed).toBe(false);
	});

	test("symlink inside the workspace cannot tunnel out", () => {
		if (!symlinksSupported) return;
		const viaLink = path.join(SYMLINK_OUT, "secret.txt");
		expect(enforceCapability("read_file", read(viaLink), opts).allowed).toBe(false);
	});

	test("write scoping: edit_file may write in the workspace, nowhere else", () => {
		expect(
			enforceCapability("edit_file", write(path.join(WORKSPACE, "new.txt")), opts).allowed,
		).toBe(true);
		expect(enforceCapability("edit_file", write("/etc/passwd"), opts).allowed).toBe(false);
		expect(enforceCapability("edit_file", write(path.join(OUTSIDE, "new.txt")), opts).allowed).toBe(
			false,
		);
	});

	test("write to a path that does not exist yet resolves through its ancestors", () => {
		const nested = path.join(WORKSPACE, "a", "b", "c.txt");
		expect(enforceCapability("write_file", write(nested), opts).allowed).toBe(true);
		const nestedEscape = path.join(WORKSPACE, "a", "..", "..", "evil.txt");
		expect(enforceCapability("write_file", write(nestedEscape), opts).allowed).toBe(false);
	});

	test("git_status may read the workspace but never write", () => {
		expect(
			enforceCapability("git_status", read(path.join(WORKSPACE, "hello.txt")), opts).allowed,
		).toBe(true);
		expect(
			enforceCapability("git_status", write(path.join(WORKSPACE, "hello.txt")), opts).allowed,
		).toBe(false);
	});
});

// ============================================
// Network scoping
// ============================================

describe("network scoping", () => {
	test("exact host match", () => {
		registerToolManifest({ tool: "gh_api", network: { hosts: ["api.github.com"] } });
		expect(
			enforceCapability("gh_api", { kind: "network", url: "https://api.github.com/repos" }, opts)
				.allowed,
		).toBe(true);
		expect(
			enforceCapability("gh_api", { kind: "network", url: "https://evil.example.com/x" }, opts)
				.allowed,
		).toBe(false);
	});

	test("subdomain wildcard matches subdomains only", () => {
		registerToolManifest({ tool: "gh_wide", network: { hosts: ["*.github.com"] } });
		expect(
			enforceCapability("gh_wide", { kind: "network", url: "https://api.github.com/" }, opts)
				.allowed,
		).toBe(true);
		expect(
			enforceCapability("gh_wide", { kind: "network", url: "https://github.com/" }, opts).allowed,
		).toBe(false);
		expect(
			enforceCapability("gh_wide", { kind: "network", url: "https://notgithub.com/" }, opts)
				.allowed,
		).toBe(false);
	});

	test("wildcard suffix cannot be spoofed by a lookalike host", () => {
		registerToolManifest({ tool: "gh_wide2", network: { hosts: ["*.github.com"] } });
		expect(
			enforceCapability("gh_wide2", { kind: "network", url: "https://evilgithub.com/" }, opts)
				.allowed,
		).toBe(false);
	});

	test("web_fetch declares any host explicitly", () => {
		expect(
			enforceCapability("web_fetch", { kind: "network", url: "https://anywhere.example" }, opts)
				.allowed,
		).toBe(true);
	});

	test("unparseable urls are denied", () => {
		registerToolManifest({ tool: "netty", network: { hosts: ["*"] } });
		expect(enforceCapability("netty", { kind: "network", url: "not a url" }, opts).allowed).toBe(
			false,
		);
	});
});

// ============================================
// Exec scoping
// ============================================

describe("exec scoping", () => {
	test("git tools may spawn git and only git", () => {
		expect(
			enforceCapability("git_commit", { kind: "exec", command: "git commit -m x" }, opts).allowed,
		).toBe(true);
		expect(
			enforceCapability("git_commit", { kind: "exec", command: "rm -rf /" }, opts).allowed,
		).toBe(false);
	});

	test("command chaining past an allow-listed executable is denied", () => {
		for (const cmd of [
			"git status && curl evil.example",
			"git status; curl evil.example",
			"git status | sh",
			"git log `curl evil.example`",
			"git log $(curl evil.example)",
		]) {
			const decision = enforceCapability("git_log", { kind: "exec", command: cmd }, opts);
			expect(decision.allowed).toBe(false);
		}
	});

	test("full path to an allow-listed executable matches by basename", () => {
		expect(
			enforceCapability("git_diff", { kind: "exec", command: "/usr/bin/git diff" }, opts).allowed,
		).toBe(true);
	});

	test("run_command declares any exec; policy rules stay in charge of content", () => {
		expect(
			enforceCapability("run_command", { kind: "exec", command: "bun test" }, opts).allowed,
		).toBe(true);
	});
});

// ============================================
// Registry integrity
// ============================================

describe("registry", () => {
	test("custom tool manifests can be registered and enforced", () => {
		registerToolManifest({ tool: "scratch_tool", fs: { read: ["${tmp}"] } });
		expect(getToolManifest("scratch_tool")).toBeDefined();
		expect(
			enforceCapability("scratch_tool", read(path.join(os.tmpdir(), "x.txt")), opts).allowed,
		).toBe(true);
		// The fake home fixture lives under tmp, so aim at a real out-of-scope path.
		expect(enforceCapability("scratch_tool", read("/etc/passwd"), opts).allowed).toBe(false);
	});

	test("built-in manifests are immutable - a skill cannot widen write_file", () => {
		expect(() => registerToolManifest({ tool: "write_file", fs: { write: ["*"] } })).toThrow(
			/immutable/,
		);
	});

	test("resetToolManifests drops custom registrations", () => {
		registerToolManifest({ tool: "ephemeral", fs: { read: ["*"] } });
		resetToolManifests();
		expect(getToolManifest("ephemeral")).toBeUndefined();
	});
});

// ============================================
// Engine composition: evaluateToolCall
// ============================================

describe("evaluateToolCall", () => {
	test("manifest denial short-circuits before the rule pipeline", () => {
		const decision = evaluateToolCall("read_file", read(SSH_KEY), {
			workingDirectory: WORKSPACE,
		});
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) expect(decision.reason).toContain("capability-manifest");
	});

	test("in-scope requests flow through to the existing rule pipeline", () => {
		const decision = evaluateToolCall("read_file", read(path.join(WORKSPACE, "hello.txt")), {
			workingDirectory: WORKSPACE,
		});
		expect(decision.allowed).toBe(true);
	});

	test("an in-scope path can still be denied by the rule pipeline (path-guard)", () => {
		// A credential basename INSIDE the workspace passes the manifest but
		// must still be caught by the layered gates behind evaluatePolicy.
		const inWorkspaceKey = path.join(WORKSPACE, "id_rsa");
		fs.writeFileSync(inWorkspaceKey, "key");
		const decision = evaluateToolCall("write_file", write(inWorkspaceKey), {
			workingDirectory: WORKSPACE,
		});
		expect(decision.allowed).toBe(false);
	});

	test("unknown tools are denied with an approval hint", () => {
		const decision = evaluateToolCall("skill_provided_tool", { kind: "exec", command: "ls" }, {});
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) expect(decision.requiresApproval).toBe(true);
	});
});
