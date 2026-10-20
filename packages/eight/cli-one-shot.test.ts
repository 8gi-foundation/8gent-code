import { describe, expect, test } from "bun:test";
import { executeOneShot } from "./cli";

type Stub = {
	content?: string;
	throws?: string;
	key?: string | null;
	keyEnv?: string;
	known?: boolean;
};

function stub(s: Stub) {
	return {
		isKnownProvider: () => s.known ?? true,
		setActiveProvider: () => {},
		getActiveProvider: () =>
			({ name: "stub", displayName: "Stub", apiKeyEnv: s.keyEnv ?? "" }) as never,
		getApiKey: () => s.key ?? null,
		chat: async () => {
			if (s.throws) throw new Error(s.throws);
			return { content: s.content ?? "", model: "m", provider: "stub" } as never;
		},
	};
}

const run = (args: string[], s: Stub, stdin = "") =>
	executeOneShot(["--cli", ...args], { manager: stub(s), readStdin: async () => stdin });

describe("one-shot cli", () => {
	test("normal prompt prints text and exits 0", async () => {
		const r = await run(["hello"], { content: "hi there" });
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toBe("hi there\n");
	});
	test("json mode prints the answer in the response field", async () => {
		const r = await run(["--json", "hello"], { content: "hi" });
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(r.stdout).response).toBe("hi");
	});
	test("empty completion exits non-zero with the named reason", async () => {
		for (const content of ["", "   \n"]) {
			const r = await run(["hello"], { content });
			expect(r.exitCode).toBe(1);
			expect(r.stdout).toBe("");
			expect(r.stderr).toContain("empty-completion");
			expect(r.stderr).toContain("Next:");
		}
	});
	test("missing key exits non-zero with the named reason", async () => {
		const r = await run(["hello"], { keyEnv: "STUB_KEY", key: null, content: "x" });
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("no-key");
		expect(r.stderr).toContain("STUB_KEY");
	});
	test("no prompt exits non-zero with the named reason", async () => {
		const r = await run([], { content: "x" });
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("no-prompt");
	});
	test("stdin prompt is used when no argument is given", async () => {
		const r = await run([], { content: "ok" }, "from stdin");
		expect(r.exitCode).toBe(0);
	});
	test("unknown provider exits non-zero with the named reason", async () => {
		const r = await run(["--provider", "nope", "hello"], { known: false, content: "x" });
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("unknown-provider");
	});
	test("model not available and request failure are named", async () => {
		const a = await run(["hello"], { throws: "Stub error: 404 No endpoints found for model" });
		expect(a.stderr).toContain("model-unavailable");
		const b = await run(["hello"], { throws: "fetch failed" });
		expect(b.stderr).toContain("request-failed");
		expect(a.exitCode).toBe(1);
		expect(b.exitCode).toBe(1);
	});
	test("no path exits 0 with empty stdout", async () => {
		const cases: Stub[] = [
			{ content: "" },
			{ content: "  " },
			{ content: "a" },
			{ throws: "boom" },
			{ keyEnv: "K", key: null },
			{ known: false },
		];
		for (const c of cases) {
			for (const args of [["hi"], ["--json", "hi"], ["--provider", "x", "hi"], []]) {
				const r = await run(args, c);
				if (r.exitCode === 0) expect(r.stdout.trim().length).toBeGreaterThan(0);
				else expect(r.stderr.length).toBeGreaterThan(0);
			}
		}
	});
});

describe("input gate (#4530)", () => {
	test("an unknown slash line is answered locally and never reaches the model", async () => {
		let chats = 0;
		const manager = {
			chat: async () => {
				chats++;
				return { content: "x", provider: "p", model: "m" };
			},
			setActiveProvider: () => {},
			isKnownProvider: () => true,
			getActiveProvider: () => ({ name: "p", displayName: "P" }),
			getApiKey: () => "k",
		} as never;
		const out = await executeOneShot(["--cli", "/definitely-not-a-command"], { manager });
		expect(chats).toBe(0);
		expect(out.exitCode).toBe(0);
		expect(out.stdout.trim().length).toBeGreaterThan(0);
	});
});
