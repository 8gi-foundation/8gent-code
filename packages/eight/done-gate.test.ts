import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DONE_GATE_TAG,
	detectProjectCheck,
	doneGateAttempts,
	doneGateTimeoutSec,
	finishWithProjectCheck,
	projectFingerprint,
	readCheck,
} from "./done-gate";

const dirs: string[] = [];
const dir = () => {
	const d = mkdtempSync(join(tmpdir(), "donegate-unit-"));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const RUST_RED =
	"Exit code 101:\n\n   Compiling ex v0.1.0\nerror[E0308]: mismatched types\n --> src/lib.rs:1:40\nerror: could not compile `ex` (lib) due to 1 previous error\n";

describe("detectProjectCheck", () => {
	test("Cargo.toml -> cargo test", () => {
		const d = dir();
		writeFileSync(join(d, "Cargo.toml"), "[package]\nname='x'\n");
		expect(detectProjectCheck(d)).toBe("cargo test");
	});
	test("package.json test script -> its runner", () => {
		const d = dir();
		writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
		expect(detectProjectCheck(d)).toBe("bun run test");
	});
	test("go.mod -> go test ./...", () => {
		const d = dir();
		writeFileSync(join(d, "go.mod"), "module x\n");
		expect(detectProjectCheck(d)).toBe("go test ./...");
	});
	test("nothing known -> null", () => {
		expect(detectProjectCheck(dir())).toBeNull();
	});
});

describe("readCheck", () => {
	test("clean exit is green", () => {
		expect(readCheck("running 1 test\ntest adds ... ok", 300).kind).toBe("pass");
	});
	test("non-zero exit is red and names rustc's diagnostic", () => {
		const r = readCheck(RUST_RED, 300);
		expect(r.kind).toBe("fail");
		if (r.kind === "fail") expect(r.firstFailure).toBe("error[E0308]: mismatched types");
	});
	test("a signal kill is red", () => {
		expect(readCheck("Exit code null:\nkilled", 300).kind).toBe("fail");
	});
	test("runner missing, timeout, or gate marker is unverified, never green", () => {
		expect(readCheck("Exit code 127:\nsh: cargo: command not found", 300).kind).toBe("unverified");
		expect(readCheck("TIMEOUT after 300s. Partial output:", 300).kind).toBe("unverified");
		expect(readCheck("[PERMISSION DENIED] run_command", 300).kind).toBe("unverified");
		expect(readCheck("", 300).kind).toBe("unverified");
	});
});

describe("env knobs", () => {
	test("attempts default 2, clamp 0..5, junk falls back", () => {
		expect(doneGateAttempts({})).toBe(2);
		expect(doneGateAttempts({ EIGHT_DONE_GATE_ATTEMPTS: "0" })).toBe(0);
		expect(doneGateAttempts({ EIGHT_DONE_GATE_ATTEMPTS: "99" })).toBe(5);
		expect(doneGateAttempts({ EIGHT_DONE_GATE_ATTEMPTS: "-1" })).toBe(2);
	});
	test("timeout default and ceiling 300", () => {
		expect(doneGateTimeoutSec({})).toBe(300);
		expect(doneGateTimeoutSec({ EIGHT_DONE_GATE_TIMEOUT_SEC: "60" })).toBe(60);
		expect(doneGateTimeoutSec({ EIGHT_DONE_GATE_TIMEOUT_SEC: "9000" })).toBe(300);
	});
});

describe("projectFingerprint", () => {
	test("changes when a source file changes, ignores build output", () => {
		const d = dir();
		mkdirSync(join(d, "src"));
		mkdirSync(join(d, "target"));
		writeFileSync(join(d, "src", "lib.rs"), "a");
		const a = projectFingerprint(d);
		writeFileSync(join(d, "target", "out"), "build artefact");
		expect(projectFingerprint(d)).toBe(a);
		writeFileSync(join(d, "src", "lib.rs"), "ab");
		expect(projectFingerprint(d)).not.toBe(a);
	});
});

describe("finishWithProjectCheck", () => {
	const cargo = () => {
		const d = dir();
		writeFileSync(join(d, "Cargo.toml"), "[package]\nname='x'\n");
		return d;
	};

	test("red, then the model fixes it: pass after one fix round, failure fed back", async () => {
		const outputs = [RUST_RED, "test result: ok"];
		const sent: string[] = [];
		const v = await finishWithProjectCheck({
			cwd: cargo(),
			changed: true,
			finalText: "DONE: first",
			run: async () => outputs.shift() as string,
			chat: async (m) => {
				sent.push(m);
				return "DONE: fixed";
			},
			env: {},
		});
		expect(v.status).toBe("pass");
		expect(v.fixRounds).toBe(1);
		expect(v.finalText).toBe("DONE: fixed");
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain(DONE_GATE_TAG);
		expect(sent[0]).toContain("error[E0308]: mismatched types");
	});

	test("still red after the budget: fail, exactly `attempts` fix rounds", async () => {
		let runs = 0;
		let chats = 0;
		const v = await finishWithProjectCheck({
			cwd: cargo(),
			changed: true,
			finalText: "DONE",
			run: async () => {
				runs++;
				return RUST_RED;
			},
			chat: async () => {
				chats++;
				return "DONE: tried";
			},
			env: { EIGHT_DONE_GATE_ATTEMPTS: "2" },
		});
		expect(v.status).toBe("fail");
		expect(chats).toBe(2);
		expect(runs).toBe(3);
		expect(v.detail).toContain("cargo test");
	});

	test("unchanged project, gate off, or no known check: skipped, nothing run", async () => {
		const never = async () => {
			throw new Error("must not run");
		};
		for (const [cwd, changed, env] of [
			[cargo(), false, {}],
			[cargo(), true, { EIGHT_DONE_GATE: "0" }],
			[dir(), true, {}],
		] as const) {
			const v = await finishWithProjectCheck({
				cwd,
				changed,
				finalText: "DONE",
				run: never,
				chat: never,
				env,
			});
			expect(v.status).toBe("skipped");
		}
	});

	test("timeout is unverified and does not loop", async () => {
		let chats = 0;
		const v = await finishWithProjectCheck({
			cwd: cargo(),
			changed: true,
			finalText: "DONE",
			run: async () => "TIMEOUT after 300s.",
			chat: async () => {
				chats++;
				return "";
			},
			env: {},
		});
		expect(v.status).toBe("unverified");
		expect(chats).toBe(0);
	});
});
