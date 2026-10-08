/**
 * A child that ends before writing every file in its scope is asked to finish
 * by the SAME child, not left for the Orchestrator to re-spawn.
 *
 * Pilot orch-route-three (2026-10-08 20:03): the 8MO child edited ABOUT.md,
 * ended "completed" without writing notes/8MO.md, and the Orchestrator spawned
 * a fourth child to write the note. The checker then failed
 * each_note_by_its_own_child. Only the model is mocked here: the real AgentPool
 * runs the child, a scripted Agent plays the provider.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Events = {
	onToolEnd?: (e: { toolName: string; success: boolean; args: { path: string } }) => void;
};
type Script = (
	turn: number,
	prompt: string,
	wd: string,
	write: (rel: string, body: string) => void,
) => string;

let script: Script;
let instances = 0;
const prompts: string[] = [];

class FakeAgent {
	private turn = 0;
	private wd: string;
	private events: Events;
	constructor(cfg: { workingDirectory: string; events?: Events }) {
		instances++;
		this.wd = cfg.workingDirectory;
		this.events = cfg.events ?? {};
	}
	async isReady() {
		return true;
	}
	getHistoryLength() {
		return this.turn;
	}
	async chat(prompt: string) {
		prompts.push(prompt);
		const write = (rel: string, body: string) => {
			mkdirSync(join(this.wd, rel, ".."), { recursive: true });
			writeFileSync(join(this.wd, rel), body);
			this.events.onToolEnd?.({ toolName: "write_file", success: true, args: { path: rel } });
		};
		return script(this.turn++, prompt, this.wd, write);
	}
}

mock.module("../eight", () => ({ Agent: FakeAgent }));

const { AgentPool } = await import("./index");

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "own-note-"));
	writeFileSync(join(dir, "ABOUT.md"), "# T\n\nlong tagline here\n");
	instances = 0;
	prompts.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = async (allowedPaths: string[], maxFollowUps?: number) => {
	const pool = new AgentPool(4);
	const a = await pool.spawnAgent("shorten the tagline, then write notes/8MO.md", {
		workingDirectory: dir,
		allowedPaths,
	});
	await pool.joinAgent(a.id, 10_000);
	return a;
};

describe("a child finishes its own scope", () => {
	test("ended after editing only ABOUT.md: the same child is asked for the note, no new child", async () => {
		script = (turn, _p, _wd, write) => {
			if (turn === 0) {
				write("ABOUT.md", "# T\n\nshort\n");
				return "done";
			}
			write("notes/8MO.md", "Shortened the tagline.");
			return "note written";
		};
		const a = await run(["ABOUT.md", "notes/8MO.md"]);
		expect(a.status).toBe("completed");
		expect(instances).toBe(1);
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain("notes/8MO.md");
		expect(prompts[1]).not.toContain("ABOUT.md");
		expect(readFileSync(join(dir, "notes/8MO.md"), "utf8")).toBe("Shortened the tagline.");
		expect(a.filesChanged).toEqual(["ABOUT.md", "notes/8MO.md"]);
	});

	test("a child that wrote everything is not prompted again", async () => {
		script = (_t, _p, _wd, write) => {
			write("ABOUT.md", "x\n");
			write("notes/8MO.md", "n");
			return "done";
		};
		await run(["ABOUT.md", "notes/8MO.md"]);
		expect(prompts).toHaveLength(1);
	});

	test("an agent with no scope is never prompted twice", async () => {
		script = () => "done";
		const pool = new AgentPool(4);
		const a = await pool.spawnAgent("read only", { workingDirectory: dir });
		await pool.joinAgent(a.id, 10_000);
		expect(prompts).toHaveLength(1);
	});

	test("a child that never writes the note is asked at most twice more, then ends", async () => {
		script = () => "done";
		const a = await run(["ABOUT.md", "notes/8MO.md"]);
		expect(prompts).toHaveLength(3);
		expect(a.status).toBe("completed");
		expect(existsSync(join(dir, "notes/8MO.md"))).toBe(false);
	});

	test("a directory in the scope is not demanded as a file", async () => {
		mkdirSync(join(dir, "notes"));
		script = (_t, _p, _wd, write) => {
			write("ABOUT.md", "x\n");
			return "done";
		};
		await run(["ABOUT.md", "notes"]);
		expect(prompts).toHaveLength(1);
	});
});
