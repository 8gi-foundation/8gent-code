/**
 * DjDeck open/close guardrail (#2934, part of #2922).
 *
 * `/dj open`, `/dj close` and Ctrl+D in app.tsx do exactly one thing each:
 * call setDjDeckOpen(true), setDjDeckOpen(false) or toggleDjDeckOpen(). This
 * mounts the real stateful DjDeck (polling, hydration, DJ backend and all)
 * into a headless Ink render and drives those three entry points, asserting
 * the deck flips between the expanded 8GENT FM box and the one-line strip.
 *
 * Isolation: the deck persists its open state through the workspace DB, which
 * resolves to <cwd>/.8gent/state.db, so the test runs in a throwaway cwd and
 * restores any prior value it found. Nothing plays: the DJ backend reports
 * "Nothing playing." and never opens an IPC socket.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import type React from "react";
import { closeWorkspaceDb, getWorkspaceDb } from "../../../../../packages/db/src/index";
import { DjDeck, setDjDeckOpen, toggleDjDeckOpen } from "../DjDeck";

const PERSIST_APP_ID = "tui";
const PERSIST_KEY = "djDeckExpanded";

class FakeStdout extends EventEmitter {
	columns = 100;
	rows = 40;
	isTTY = true;
	frames: string[] = [];
	write = (frame: string): boolean => {
		this.frames.push(frame);
		return true;
	};
	lastFrame(): string {
		return this.frames.at(-1) ?? "";
	}
}

class FakeStdin extends EventEmitter {
	isTTY = false;
	setEncoding(): this {
		return this;
	}
	setRawMode(): this {
		return this;
	}
	resume(): this {
		return this;
	}
	pause(): this {
		return this;
	}
	ref(): this {
		return this;
	}
	unref(): this {
		return this;
	}
	read(): null {
		return null;
	}
}

function plain(frame: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping needs the escape byte
	return frame.replace(/\[[0-9;]*m/g, "");
}

function mount(element: React.ReactElement): { stdout: FakeStdout; unmount: () => void } {
	const stdout = new FakeStdout();
	const stdin = new FakeStdin();
	const instance = render(element, {
		// Structural fakes stand in for the real streams in headless tests.
		stdout: stdout as unknown as NodeJS.WriteStream,
		stdin: stdin as unknown as NodeJS.ReadStream,
		debug: true,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	return { stdout, unmount: () => instance.unmount() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(
	stdout: FakeStdout,
	predicate: (frame: string) => boolean,
	timeoutMs = 4000,
): Promise<string> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const frame = plain(stdout.lastFrame());
		if (predicate(frame)) return frame;
		await sleep(25);
	}
	return plain(stdout.lastFrame());
}

const rows = (frame: string) => frame.replace(/\s+$/, "").split("\n");

/** Expanded, nothing playing: a bordered box with the station name and a hint. */
const isExpandedIdle = (f: string) =>
	f.includes("● 8GENT FM") && f.includes("/dj open") && rows(f).length === 3;
/** Collapsed: the one-line strip. */
const isCollapsed = (f: string) => f.includes("■ 8GENT FM idle") && rows(f).length === 1;

let originalCwd: string;
let tempCwd: string;
let priorExpanded: boolean | null = null;

beforeAll(() => {
	originalCwd = process.cwd();
	tempCwd = mkdtempSync(join(tmpdir(), "8gent-djdeck-toggle-"));
	process.chdir(tempCwd);
	// Opens <tempCwd>/.8gent/state.db unless an earlier suite already opened
	// the shared handle elsewhere; either way remember what was there.
	priorExpanded = getWorkspaceDb().getAppState<boolean>(PERSIST_APP_ID, PERSIST_KEY);
});

afterAll(() => {
	try {
		const db = getWorkspaceDb();
		if (priorExpanded === null) db.deleteAppState(PERSIST_APP_ID, PERSIST_KEY);
		else db.setAppState(PERSIST_APP_ID, PERSIST_KEY, priorExpanded);
	} catch {
		/* best effort */
	}
	closeWorkspaceDb();
	process.chdir(originalCwd);
	rmSync(tempCwd, { recursive: true, force: true });
});

describe("DjDeck open and close (the /dj open, /dj close and Ctrl+D paths)", () => {
	test("setDjDeckOpen and toggleDjDeckOpen flip a mounted deck between box and strip", async () => {
		const { stdout, unmount } = mount(<DjDeck />);
		try {
			expect((await waitFor(stdout, (f) => f.includes("8GENT FM"))).includes("8GENT FM")).toBe(
				true,
			);
			// Let hydration from the workspace DB settle before driving state.
			await sleep(400);

			setDjDeckOpen(true); // /dj open
			const expanded = await waitFor(stdout, isExpandedIdle);
			expect(isExpandedIdle(expanded)).toBe(true);
			expect(rows(expanded)[0].startsWith("╭")).toBe(true);
			expect(expanded).toContain("idle");

			setDjDeckOpen(false); // /dj close
			const collapsed = await waitFor(stdout, isCollapsed);
			expect(isCollapsed(collapsed)).toBe(true);
			expect(collapsed).not.toContain("╭");

			toggleDjDeckOpen(); // Ctrl+D
			expect(isExpandedIdle(await waitFor(stdout, isExpandedIdle))).toBe(true);

			toggleDjDeckOpen(); // Ctrl+D again
			expect(isCollapsed(await waitFor(stdout, isCollapsed))).toBe(true);

			setDjDeckOpen(true); // /dj open is idempotent on the way back
			setDjDeckOpen(true);
			expect(isExpandedIdle(await waitFor(stdout, isExpandedIdle))).toBe(true);
		} finally {
			unmount();
		}
	}, 15000);

	test("the open choice is persisted so it survives a remount", async () => {
		const first = mount(<DjDeck />);
		try {
			await waitFor(first.stdout, (f) => f.includes("8GENT FM"));
			await sleep(400);
			setDjDeckOpen(false);
			await waitFor(first.stdout, isCollapsed);
			await sleep(200);
		} finally {
			first.unmount();
		}
		expect(getWorkspaceDb().getAppState<boolean>(PERSIST_APP_ID, PERSIST_KEY)).toBe(false);

		const second = mount(<DjDeck />);
		try {
			expect(isCollapsed(await waitFor(second.stdout, isCollapsed))).toBe(true);
			setDjDeckOpen(true);
			await waitFor(second.stdout, isExpandedIdle);
			await sleep(200);
		} finally {
			second.unmount();
		}
		expect(getWorkspaceDb().getAppState<boolean>(PERSIST_APP_ID, PERSIST_KEY)).toBe(true);
	}, 15000);

	test("while the agent is mid-turn the idle box says agent pulse", async () => {
		const { stdout, unmount } = mount(<DjDeck isProcessing={true} />);
		try {
			await sleep(400);
			setDjDeckOpen(true);
			const frame = await waitFor(stdout, (f) => f.includes("agent pulse"));
			expect(frame).toContain("● 8GENT FM");
			expect(frame).toContain("agent pulse");
		} finally {
			unmount();
		}
	}, 15000);

	test("with no deck mounted the entry points are safe no-ops", () => {
		expect(() => setDjDeckOpen(false)).not.toThrow();
		expect(() => toggleDjDeckOpen()).not.toThrow();
	});
});
