import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { evaluatePolicy } from "./policy-engine";
import {
	checkCommandBoundary,
	checkFilePathBoundary,
	isWithinWorkspace,
	resolveSafe,
	splitPipeline,
	tokenize,
} from "./src/workspace-boundary";

// Real on-disk workspace so realpathSync actually has something to canonicalise.
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "wb-workspace-"));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), "wb-outside-"));

// Real files we can refer to from tests.
fs.writeFileSync(path.join(WORKSPACE, "hello.txt"), "hi");
fs.mkdirSync(path.join(WORKSPACE, "src"), { recursive: true });
fs.writeFileSync(path.join(WORKSPACE, "src", "main.ts"), "export {}");
fs.writeFileSync(path.join(OUTSIDE, "secret.txt"), "supersecret");

// Symlink inside workspace pointing OUT — the holaOS attack surface.
const SYMLINK_OUT = path.join(WORKSPACE, "escape-link");
try {
	fs.symlinkSync(OUTSIDE, SYMLINK_OUT);
} catch {
	// CI without symlink permission — tests using SYMLINK_OUT will skip via guards.
}

const POLICY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wb-policy-"));
process.env.EIGHT_DATA_DIR = POLICY_DIR;

beforeAll(() => {
	process.env.EIGHT_WORKSPACE_ROOT = WORKSPACE;
});

afterAll(() => {
	delete process.env.EIGHT_WORKSPACE_ROOT;
});

// ============================================
// isWithinWorkspace primitive
// ============================================

describe("isWithinWorkspace", () => {
	test("accepts the workspace root itself", () => {
		expect(isWithinWorkspace(WORKSPACE, WORKSPACE)).toBe(true);
	});

	test("accepts a nested file", () => {
		expect(isWithinWorkspace(path.join(WORKSPACE, "src", "main.ts"), WORKSPACE)).toBe(true);
	});

	test("rejects a sibling directory", () => {
		expect(isWithinWorkspace(OUTSIDE, WORKSPACE)).toBe(false);
	});

	test("rejects a path that only shares a prefix string", () => {
		// /tmp/wb-workspace-abc must NOT match /tmp/wb-workspace via prefix-only.
		const sibling = `${WORKSPACE}-sibling`;
		expect(isWithinWorkspace(sibling, WORKSPACE)).toBe(false);
	});
});

// ============================================
// resolveSafe + traversal collapse
// ============================================

describe("resolveSafe collapses traversal", () => {
	test("collapses ../ in absolute paths", () => {
		const resolved = resolveSafe(`${WORKSPACE}/../etc/passwd`, WORKSPACE);
		expect(resolved.includes("/..")).toBe(false);
		expect(isWithinWorkspace(resolved, WORKSPACE)).toBe(false);
	});

	test("collapses ../ in relative paths anchored to cwd", () => {
		const resolved = resolveSafe("../../etc/passwd", WORKSPACE);
		expect(resolved.includes("/..")).toBe(false);
		expect(isWithinWorkspace(resolved, WORKSPACE)).toBe(false);
	});

	test("resolves non-existent files via deepest existing ancestor", () => {
		const ghost = resolveSafe("src/does-not-exist.ts", WORKSPACE);
		expect(ghost.startsWith(fs.realpathSync(WORKSPACE))).toBe(true);
	});
});

// ============================================
// Tokenizer
// ============================================

describe("tokenize", () => {
	test("splits on whitespace", () => {
		expect(tokenize("cat foo bar")).toEqual(["cat", "foo", "bar"]);
	});

	test("respects single quotes literally", () => {
		expect(tokenize("cat 'a b c'")).toEqual(["cat", "a b c"]);
	});

	test("respects double quotes", () => {
		expect(tokenize('cat "a b c"')).toEqual(["cat", "a b c"]);
	});

	test("respects backslash-escaped spaces outside quotes", () => {
		expect(tokenize("cat a\\ b\\ c")).toEqual(["cat", "a b c"]);
	});

	test("preserves empty quoted strings as a token", () => {
		expect(tokenize("echo ''")).toEqual(["echo", ""]);
	});

	test("does not treat quotes inside other quotes as delimiters", () => {
		expect(tokenize(`echo "it's fine"`)).toEqual(["echo", "it's fine"]);
	});
});

describe("splitPipeline", () => {
	test("splits on &&, ||, ;, and |", () => {
		expect(splitPipeline("a && b || c ; d | e")).toEqual(["a", "b", "c", "d", "e"]);
	});

	test("does not split inside quotes", () => {
		expect(splitPipeline(`echo "a && b" | wc`)).toEqual([`echo "a && b"`, "wc"]);
	});
});

// ============================================
// PATH TRAVERSAL ATTACK VECTORS (issue #2083 acceptance)
// ============================================

describe("path traversal attack vectors are all blocked", () => {
	// Vector 1: classic ../../etc/passwd
	test("vector 1: classic ../../etc/passwd via read_file", () => {
		const decision = evaluatePolicy("read_file", {
			path: "../../etc/passwd",
		});
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) {
			expect(decision.reason).toMatch(/workspace-boundary/);
		}
	});

	// Vector 2: absolute path outside workspace
	test("vector 2: absolute /etc/passwd via read_file", () => {
		const decision = evaluatePolicy("read_file", { path: "/etc/passwd" });
		expect(decision.allowed).toBe(false);
	});

	// Vector 3: cd chain to /etc then cat
	test("vector 3: cd /etc/.. && cat /etc/passwd", () => {
		const result = checkCommandBoundary("cd /etc/.. && cat /etc/passwd", WORKSPACE);
		expect(result.allowed).toBe(false);
	});

	// Vector 4: cd into outside dir then read relative
	test("vector 4: cd <OUTSIDE> && cat secret.txt", () => {
		const result = checkCommandBoundary(`cd ${OUTSIDE} && cat secret.txt`, WORKSPACE);
		expect(result.allowed).toBe(false);
	});

	// Vector 5: quoted path with escape
	test("vector 5: cat '/etc/passwd' (single-quoted)", () => {
		const result = checkCommandBoundary(`cat '/etc/passwd'`, WORKSPACE);
		expect(result.allowed).toBe(false);
	});

	// Vector 6: double-quoted absolute path
	test("vector 6: cat \"/etc/passwd\" (double-quoted)", () => {
		const result = checkCommandBoundary(`cat "/etc/passwd"`, WORKSPACE);
		expect(result.allowed).toBe(false);
	});

	// Vector 7: backslash-escaped space inside path
	test("vector 7: cat /etc/secret\\ file.txt", () => {
		const result = checkCommandBoundary(`cat /etc/secret\\ file.txt`, WORKSPACE);
		expect(result.allowed).toBe(false);
	});

	// Vector 8: symlink inside workspace pointing out (only if symlink succeeded)
	test("vector 8: symlink inside workspace pointing outside", () => {
		if (!fs.existsSync(SYMLINK_OUT)) return;
		const target = path.join(SYMLINK_OUT, "secret.txt");
		const result = checkFilePathBoundary(target, WORKSPACE);
		expect(result.allowed).toBe(false);
		if (!result.allowed) {
			// Resolved path must be canonicalised — no symlink left in it.
			const realOutside = fs.realpathSync(OUTSIDE);
			expect(result.violations[0].resolved.startsWith(realOutside)).toBe(true);
		}
	});

	// Vector 9: --output=/etc/passwd flag-style argument
	test("vector 9: tee --output=/etc/passwd", () => {
		const result = checkCommandBoundary("tee --output=/etc/passwd", WORKSPACE);
		expect(result.allowed).toBe(false);
	});

	// Vector 10: layered traversal via repeated ..
	test("vector 10: cat ./../../../../../../etc/passwd", () => {
		const result = checkCommandBoundary("cat ./../../../../../../etc/passwd", WORKSPACE);
		expect(result.allowed).toBe(false);
	});

	// Vector 11: ; chain instead of &&
	test("vector 11: pwd ; cat /etc/passwd", () => {
		const result = checkCommandBoundary("pwd ; cat /etc/passwd", WORKSPACE);
		expect(result.allowed).toBe(false);
	});

	// Vector 12: mixed-case file with .. and tilde
	test("vector 12: write_file with ../../../home/jamesspalding/.ssh/id_rsa", () => {
		const decision = evaluatePolicy("write_file", {
			path: "../../../home/jamesspalding/.ssh/id_rsa",
			content: "stolen",
		});
		expect(decision.allowed).toBe(false);
	});
});

// ============================================
// LEGITIMATE PATHS — zero false positives
// ============================================

describe("legitimate workspace paths pass", () => {
	test("relative file inside workspace", () => {
		const result = checkFilePathBoundary("src/main.ts", WORKSPACE);
		expect(result.allowed).toBe(true);
	});

	test("non-existent file destined for inside workspace", () => {
		const result = checkFilePathBoundary("src/new-file.ts", WORKSPACE);
		expect(result.allowed).toBe(true);
	});

	test("write_file via policy engine for nested workspace path", () => {
		const decision = evaluatePolicy("write_file", {
			path: "src/main.ts",
			content: "export const x = 1;",
		});
		expect(decision.allowed).toBe(true);
	});

	test("run_command with workspace-relative argument", () => {
		const result = checkCommandBoundary("cat src/main.ts", WORKSPACE);
		expect(result.allowed).toBe(true);
	});

	test("run_command with chained cd inside workspace", () => {
		const result = checkCommandBoundary("cd src && cat main.ts", WORKSPACE);
		expect(result.allowed).toBe(true);
	});

	test("commands with no path arguments pass through", () => {
		const result = checkCommandBoundary("git status", WORKSPACE);
		expect(result.allowed).toBe(true);
	});
});

// ============================================
// Allow-prefix escape hatch
// ============================================

describe("allowedAbsolutePrefixes escape hatch", () => {
	test("explicitly allowed prefix bypasses boundary", () => {
		const result = checkCommandBoundary("cat /usr/bin/env", WORKSPACE, ["/usr/bin"]);
		expect(result.allowed).toBe(true);
	});

	test("read_file under explicitly allowed prefix is permitted", () => {
		const result = checkFilePathBoundary("/usr/bin/env", WORKSPACE, ["/usr/bin"]);
		expect(result.allowed).toBe(true);
	});

	test("non-allowlisted absolute path still rejected", () => {
		const result = checkFilePathBoundary("/etc/passwd", WORKSPACE, ["/usr/bin"]);
		expect(result.allowed).toBe(false);
	});
});

// ============================================
// Pre-check ordering (boundary runs BEFORE allow rules)
// ============================================

describe("boundary gate runs before YAML rule evaluation", () => {
	test("file write inside boundary still subject to YAML rules", () => {
		// Secret-in-source rule should still block even when path is inside workspace.
		const decision = evaluatePolicy("write_file", {
			path: "src/conf.ts",
			content: "const API_KEY = 'leaked'",
		});
		expect(decision.allowed).toBe(false);
	});

	test("file write outside boundary is denied with boundary reason, not YAML reason", () => {
		const decision = evaluatePolicy("write_file", {
			path: "/etc/conf.ts",
			content: "const API_KEY = 'leaked'",
		});
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) {
			expect(decision.reason).toMatch(/workspace-boundary/);
		}
	});
});
