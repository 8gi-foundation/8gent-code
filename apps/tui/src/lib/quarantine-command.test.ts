import { describe, expect, test } from "bun:test";
import { runQuarantineCommand, type QuarantineLike } from "./quarantine-command";

function fake() {
	const calls: string[] = [];
	const qm: QuarantineLike = {
		list: () => {
			calls.push("list");
			return [];
		},
		quarantine: async () => {
			calls.push("quarantine");
			return { id: "x", name: "x" };
		},
		scan: async () => {
			calls.push("scan");
			return { verdict: "PASS" };
		},
		release: async () => {
			calls.push("release");
		},
		reject: async () => {
			calls.push("reject");
		},
	};
	return { qm, calls };
}

describe("runQuarantineCommand", () => {
	test("add never reaches the quarantine add path", async () => {
		for (const args of [["add", "anything"], ["add"], ["add", "a b", "c"]]) {
			const { qm, calls } = fake();
			const out = await runQuarantineCommand(qm, args);
			expect(calls).toEqual([]);
			expect(out).toBe("quarantine add is not available from the TUI yet.");
		}
	});
	test("list, scan, release and reject still dispatch", async () => {
		const { qm, calls } = fake();
		await runQuarantineCommand(qm, ["list"]);
		await runQuarantineCommand(qm, ["scan", "id1"]);
		await runQuarantineCommand(qm, ["release", "id1"]);
		await runQuarantineCommand(qm, ["reject", "id1", "bad"]);
		expect(calls).toEqual(["list", "scan", "release", "reject"]);
	});
});
