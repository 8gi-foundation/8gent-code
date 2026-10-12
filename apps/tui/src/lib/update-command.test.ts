import { describe, expect, test } from "bun:test";
import { launcherContext, runTuiUpdate } from "./update-command";

function harness(opts: {
	code?: number;
	updated?: boolean;
	sessionId?: string | null;
	throwUpdate?: boolean;
	throwSave?: boolean;
}) {
	const order: string[] = [];
	const said: string[] = [];
	const relaunched: { sessionId?: string; note: string }[] = [];
	const deps = {
		saveSession: () => {
			order.push("save");
			if (opts.throwSave) throw new Error("disk full");
			return opts.sessionId === undefined ? "sess_abc123" : opts.sessionId;
		},
		runUpdate: async (
			_log: (l: string) => void,
			report: (o: { updated: boolean; to?: string }) => void,
		) => {
			order.push("update");
			if (opts.throwUpdate) throw new Error("boom");
			if (opts.updated !== false && (opts.code ?? 0) === 0)
				report({ updated: true, to: "def5678" });
			return opts.code ?? 0;
		},
		say: (l: string) => said.push(l),
		relaunch: (r: { sessionId?: string; note: string }) => {
			order.push("relaunch");
			relaunched.push(r);
		},
	};
	return { deps, order, said, relaunched };
}

describe("/update in the TUI", () => {
	test("saves the session, updates, then re-launches with the session id and the one-line note", async () => {
		const h = harness({});
		expect(await runTuiUpdate(h.deps)).toBe("relaunched");
		expect(h.order).toEqual(["save", "update", "relaunch"]);
		expect(h.relaunched).toEqual([
			{ sessionId: "sess_abc123", note: "Updated to def5678, resumed your session." },
		]);
	});

	test("a failed update stays in the session: no re-launch, error shown", async () => {
		const h = harness({ code: 1 });
		expect(await runTuiUpdate(h.deps)).toBe("failed");
		expect(h.relaunched).toEqual([]);
		expect(h.said.join("\n")).toContain("Your session is still open");
	});

	test("an update that throws keeps the session too", async () => {
		const h = harness({ throwUpdate: true });
		expect(await runTuiUpdate(h.deps)).toBe("failed");
		expect(h.relaunched).toEqual([]);
		expect(h.said.join("\n")).toContain("Update failed: boom");
	});

	test("if the session cannot be saved first, nothing is updated", async () => {
		const h = harness({ throwSave: true });
		expect(await runTuiUpdate(h.deps)).toBe("failed");
		expect(h.order).toEqual(["save"]);
	});

	test("nothing new: no re-launch", async () => {
		const h = harness({ updated: false });
		expect(await runTuiUpdate(h.deps)).toBe("unchanged");
		expect(h.relaunched).toEqual([]);
	});

	test("no active session: still re-launches, without claiming a resume", async () => {
		const h = harness({ sessionId: null });
		await runTuiUpdate(h.deps);
		expect(h.relaunched).toEqual([{ sessionId: undefined, note: "Updated to def5678." }]);
	});

	test("launcherContext reads what the launcher set", () => {
		expect(
			launcherContext(
				{
					EIGHT_RUNNING_VERSION: "0.18.0",
					EIGHT_LAUNCHER_MODULE: "file:///x/bin/8gent.ts",
					EIGHT_LAUNCHER_EMBEDDED: "1",
				},
				"file:///here",
			),
		).toEqual({
			currentVersion: "0.18.0",
			modulePath: "file:///x/bin/8gent.ts",
			embedded: true,
		});
		expect(launcherContext({}, "file:///here").modulePath).toBe("file:///here");
	});
});
