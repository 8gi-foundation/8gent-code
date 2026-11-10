/**
 * A terminal tab's session outlives its view (switching tabs unmounts the view),
 * a failed start says why inside the tab, and write_terminal / read_terminal
 * reach the session a person sees.
 *
 * The real-pty cases skip with a printed reason when the host refuses a pty (a
 * sandbox), so a sandbox is never a false failure. CI never skips them.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { findNodeBinary } from "../../../../packages/terminal-tab/find-node.js";
import {
	closeTerminal,
	listTerminals,
	openTerminal,
	pruneTerminals,
	readTerminal,
	subscribeTerminal,
	terminalState,
	writeToTerminal,
} from "./useTerminal.js";

const nodeBin = findNodeBinary();
const posix = process.platform !== "win32";
const onCI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);

// python3's os.openpty is independent of node-pty; inconclusive means run.
function ptyDenied(): string | null {
	if (!posix) return "no pty on this platform";
	const r = spawnSync("python3", ["-c", "import os; os.openpty()"], { encoding: "utf-8" });
	if (r.error || r.status === null) return null;
	return r.status === 0
		? null
		: `this host refuses pseudo-terminals (${r.stderr.trim().slice(-80)})`;
}
const denied = onCI ? null : ptyDenied();
if (denied) console.warn(`[useTerminal-session] skipping real-pty cases: ${denied}`);
const realPty = it.skipIf(Boolean(denied) || !nodeBin || !posix);

const until = async (fn: () => boolean, ms = 8000) => {
	const end = Date.now() + ms;
	while (!fn() && Date.now() < end) await Bun.sleep(25);
	return fn();
};

const ids: string[] = [];
const open = (id: string, opts: Parameters<typeof openTerminal>[1]) => {
	ids.push(id);
	openTerminal(id, opts);
};
afterEach(() => {
	for (const id of ids.splice(0)) closeTerminal(id);
	process.env.NODE_8GENT_BIN = savedNode;
	if (savedNode === undefined) delete process.env.NODE_8GENT_BIN;
});
const savedNode = process.env.NODE_8GENT_BIN;

describe("a failed start is shown in the tab", () => {
	it("a helper that dies without a word ends in a plain line within two seconds", async () => {
		// /bin/false is an executable that is not node: the bridge never says anything.
		process.env.NODE_8GENT_BIN = "/bin/false";
		open("fail-1", { command: "/bin/sh" });
		const t0 = Date.now();
		const shown = await until(
			() => terminalState("fail-1").lines.some((l) => l.startsWith("could not start a terminal:")),
			2000,
		);
		expect(shown).toBe(true);
		expect(Date.now() - t0).toBeLessThan(2000);
		expect(terminalState("fail-1").isRunning).toBe(false);
	});
});

describe("a tab's session outlives its view", () => {
	realPty(
		"keeps running, keeps its output and stays reachable after the view detaches",
		async () => {
			open("live-1", { command: "/bin/sh", args: ["-i"] });
			let changes = 0;
			const detach = subscribeTerminal("live-1", () => changes++);
			expect(await until(() => terminalState("live-1").isRunning)).toBe(true);
			const pid = terminalState("live-1").pid;

			// write_terminal's path: text goes to the PTY the person sees
			expect(writeToTerminal("live-1", "echo ok-from-tab")).toContain("Sent");
			expect(await until(() => (readTerminal("live-1", 20) ?? []).includes("ok-from-tab"))).toBe(
				true,
			);
			expect(changes).toBeGreaterThan(0);

			// the view unmounts (switch to chat tab 1) and mounts again
			detach();
			openTerminal("live-1", {}); // a second mount reuses the session
			expect(terminalState("live-1").pid).toBe(pid);
			expect(terminalState("live-1").isRunning).toBe(true);
			expect(terminalState("live-1").lines.map((l) => l.trim())).toContain("ok-from-tab");

			// still reachable from chat while the view is away
			writeToTerminal("live-1", "echo still-here");
			expect(await until(() => (readTerminal("live-1", 20) ?? []).includes("still-here"))).toBe(
				true,
			);
		},
	);

	realPty("closing the tab ends the session, and so does a pruned tab id", async () => {
		open("live-2", { command: "/bin/sh", args: ["-i"] });
		open("live-3", { command: "/bin/sh", args: ["-i"] });
		expect(await until(() => terminalState("live-2").isRunning)).toBe(true);
		pruneTerminals(new Set(["live-3"]));
		expect(listTerminals()).not.toContain("live-2");
		expect(listTerminals()).toContain("live-3");
		closeTerminal("live-3");
		expect(listTerminals()).not.toContain("live-3");
		expect(writeToTerminal("live-3", "echo x")).toContain("No terminal open");
	});

	it("write_terminal to a tab that does not exist says so", () => {
		expect(writeToTerminal("no-such-tab", "echo x")).toBe("No terminal open for tab no-such-tab");
		expect(readTerminal("no-such-tab", 5)).toBeNull();
	});
});
