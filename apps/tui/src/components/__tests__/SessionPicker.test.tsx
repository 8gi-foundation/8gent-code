/**
 * SessionPicker: pure logic (reducer, key map, filtering) plus the rendered
 * text of the view, against real listSessions() output from a temp store.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renderToString } from "ink";
import React from "react";
import {
	type SessionListItem,
	SessionStore,
	listSessions,
	trashSession,
} from "../../../../../packages/eight/session-store";
import {
	type KeyLike,
	type PickerState,
	SessionPickerView,
	ago,
	initialPickerState,
	keyToAction,
	pickerReducer,
	visibleSessions,
} from "../SessionPicker";

let dir: string;
let sessions: SessionListItem[];
const NOW = Date.parse("2026-10-11T12:00:00Z");

function make(cwd: string, name: string | undefined, minsAgo: number): string {
	const s = SessionStore.create({ cwd, name, model: "qwen" }, dir);
	s.append({ role: "user", content: `hello from ${name ?? "nobody"}` });
	const at = new Date(NOW - minsAgo * 60_000);
	fs.utimesSync(s.file, at, at);
	return s.id;
}

let ids: Record<string, string>;
beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-picker-"));
	ids = {
		auth: make("/work/a", "auth fix", 5),
		zeta: make("/work/a", "zeta refactor", 120),
		anon: make("/work/a", undefined, 1),
		other: make("/work/b", "other repo", 2),
	};
	sessions = listSessions({ sessionsDir: dir });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Drive the picker with a key sequence; returns final state and every effect. */
function press(keys: Array<[string, KeyLike]>, cwd = "/work/a", state = initialPickerState()) {
	const effects: unknown[] = [];
	let s: PickerState = state;
	for (const [input, key] of keys) {
		const rows = visibleSessions(sessions, s, cwd);
		const { action, effect } = keyToAction(input, key, s, rows);
		if (action) s = pickerReducer(s, action);
		if (effect) effects.push(effect);
	}
	return { state: s, effects, rows: visibleSessions(sessions, s, cwd) };
}

const names = (rows: SessionListItem[]) => rows.map((r) => r.name ?? r.id);

describe("visibleSessions", () => {
	test("starts scoped to this folder, newest first", () => {
		expect(names(visibleSessions(sessions, initialPickerState(), "/work/a"))).toEqual([
			ids.anon,
			"auth fix",
			"zeta refactor",
		]);
	});

	test("Tab shows every folder; Ctrl+N named only; Ctrl+S sorts by name", () => {
		expect(press([["", { tab: true }]]).rows).toHaveLength(4);
		expect(names(press([["n", { ctrl: true }]]).rows)).toEqual(["auth fix", "zeta refactor"]);
		expect(names(press([["s", { ctrl: true }]]).rows)).toEqual([
			"auth fix",
			"zeta refactor",
			ids.anon,
		]);
	});

	test("typing searches name, id, folder and model", () => {
		expect(
			names(
				press([
					["z", {}],
					["e", {}],
					["t", {}],
				]).rows,
			),
		).toEqual(["zeta refactor"]);
		expect(
			press([
				["", { tab: true }],
				["/", {}],
				["b", {}],
			]).rows.map((r) => r.id),
		).toEqual([ids.other]);
		expect(
			press([
				["q", {}],
				["w", {}],
				["e", {}],
				["n", {}],
			]).rows,
		).toHaveLength(3);
		const back = press([
			["z", {}],
			["", { backspace: true }],
		]);
		expect(back.state.query).toBe("");
	});
});

describe("keys", () => {
	test("Enter opens the selected row; arrows move and clamp", () => {
		expect(press([["", { return: true }]]).effects).toEqual([{ type: "open", id: ids.anon }]);
		const moved = press([
			["", { downArrow: true }],
			["", { downArrow: true }],
			["", { downArrow: true }],
			["", { return: true }],
		]);
		expect(moved.effects).toEqual([{ type: "open", id: ids.zeta }]);
		expect(press([["", { upArrow: true }]]).state.active).toBe(0);
	});

	test("Esc closes", () => {
		expect(press([["", { escape: true }]]).effects).toEqual([{ type: "close" }]);
	});

	test("Ctrl+R renames: prefilled with the current name, Enter saves, Esc cancels", () => {
		const keys: Array<[string, KeyLike]> = [
			["", { downArrow: true }],
			["r", { ctrl: true }],
			["", { backspace: true }],
			["", { backspace: true }],
			["", { backspace: true }],
			["X", {}],
		];
		const mid = press(keys);
		expect(mid.state).toMatchObject({ mode: "rename", draft: "auth X" });
		expect(press([...keys, ["", { return: true }]]).effects).toEqual([
			{ type: "rename", id: ids.auth, name: "auth X" },
		]);
		const cancelled = press([...keys, ["", { escape: true }]]);
		expect(cancelled.effects).toEqual([]);
		expect(cancelled.state.mode).toBe("browse");
	});

	test("Ctrl+D asks first; only y deletes", () => {
		expect(
			press([
				["d", { ctrl: true }],
				["n", {}],
			]).effects,
		).toEqual([]);
		expect(
			press([
				["d", { ctrl: true }],
				["y", {}],
			]).effects,
		).toEqual([{ type: "delete", id: ids.anon }]);
	});

	test("a deleted session leaves the list the picker is given", () => {
		const extra = make("/work/c", "doomed", 0);
		expect(trashSession(extra, dir)).toBe(true);
		const rows = visibleSessions(
			listSessions({ sessionsDir: dir }),
			{ ...initialPickerState("all") },
			"/",
		);
		expect(rows.map((r) => r.id)).not.toContain(extra);
	});
});

describe("SessionPickerView", () => {
	test("renders names, counts, ages and the key legend", () => {
		const state = initialPickerState();
		const rows = visibleSessions(sessions, state, "/work/a");
		const out = renderToString(<SessionPickerView state={state} rows={rows} now={NOW} />, {
			columns: 100,
		});
		expect(out).toContain("SESSIONS");
		expect(out).toContain("this folder");
		expect(out).toContain(`untitled ${ids.anon}`);
		expect(out).toContain("auth fix");
		expect(out).toContain("1 msgs");
		expect(out).toContain("2h");
		expect(out).toContain("rename");
		expect(out).not.toContain("/work/b");
	});

	test("an empty folder says how to see the rest", () => {
		const out = renderToString(
			<SessionPickerView state={initialPickerState()} rows={[]} now={NOW} />,
			{ columns: 100 },
		);
		expect(out).toContain("no sessions in this folder (Tab shows all)");
	});

	test("delete confirmation names the session", () => {
		const state = { ...initialPickerState(), mode: "confirm-delete" as const, active: 1 };
		const rows = visibleSessions(sessions, state, "/work/a");
		const out = renderToString(<SessionPickerView state={state} rows={rows} now={NOW} />, {
			columns: 100,
		});
		expect(out).toContain('Delete "auth fix"? y / n');
	});
});

test("ago", () => {
	expect(ago(new Date(NOW - 59_000).toISOString(), NOW)).toBe("0m");
	expect(ago(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe("3h");
	expect(ago(new Date(NOW - 50 * 3_600_000).toISOString(), NOW)).toBe("2d");
});

test("names and folders with terminal escapes render without control characters", () => {
	const evil: SessionListItem = {
		id: "evil1",
		name: "\u001b]0;pwn\u0007\u001b[2Jok",
		cwd: "/w/\u001b[31mred",
		createdAt: "x",
		lastActiveAt: new Date(NOW).toISOString(),
		messageCount: 1,
		format: "tree",
		file: "x",
	};
	const state = { ...initialPickerState("all"), mode: "confirm-delete" as const };
	const out = renderToString(<SessionPickerView state={state} rows={[evil]} now={NOW} />, {
		columns: 140,
	});
	const raw = out.replace(/\u001b\[[0-9;]*m/g, ""); // Ink's own colour codes
	expect(raw).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/);
	expect(raw).toContain("]0;pwn[2Jok");
});
