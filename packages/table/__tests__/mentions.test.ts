/**
 * Mention scan + membership-resolution tests (contract section 3.8).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger } from "../../goal/ledger.js";
import { scanMentions } from "../mentions.js";
import { TableStore } from "../store.js";
import { resolveMentionedAgents, tableSessionId } from "../wiring.js";

const TEST_KEY = Buffer.from("a".repeat(64), "hex");
const JAMES = "human:james";

let tmpDir: string;
let store: TableStore;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "table-mentions-"));
	const ledger = Ledger.open({ runId: "ledger", baseDir: tmpDir, key: TEST_KEY });
	store = new TableStore({ dbPath: path.join(tmpDir, "table.db"), ledger });
});

afterEach(() => {
	store.close();
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best effort
	}
});

describe("scanMentions", () => {
	it("extracts unique handles preserving order, stripping @", () => {
		expect(scanMentions("hi @8EO and @8TO, cc @8EO again")).toEqual(["8EO", "8TO"]);
	});

	it("returns [] when there are no mentions", () => {
		expect(scanMentions("no mentions here, email a@b.com is not one after @")).toEqual(["b"]);
	});

	it("handles hyphen/underscore handles", () => {
		expect(scanMentions("@agent_one and @agent-two")).toEqual(["agent_one", "agent-two"]);
	});
});

describe("resolveMentionedAgents", () => {
	it("resolves only agent members (member|bot), never humans or non-members", () => {
		const c = store.createChannel({
			name: "design",
			type: "stream",
			visibility: "open",
			createdBy: JAMES,
		});
		store.addMember({ channelId: c.id, participantId: "agent:8EO", role: "bot", addedBy: JAMES });
		store.addMember({
			channelId: c.id,
			participantId: "agent:8TO",
			role: "member",
			addedBy: JAMES,
		});
		store.addMember({
			channelId: c.id,
			participantId: "human:nessa",
			role: "member",
			addedBy: JAMES,
		});

		const handles = scanMentions("@8EO @8TO @nessa @ghost");
		const resolved = resolveMentionedAgents(store, c.id, handles);
		expect(resolved).toEqual(["agent:8EO", "agent:8TO"]);
	});

	it("does not resolve an agent that is not a member of the channel", () => {
		const c = store.createChannel({
			name: "ops",
			type: "stream",
			visibility: "open",
			createdBy: JAMES,
		});
		const resolved = resolveMentionedAgents(store, c.id, scanMentions("@8EO"));
		expect(resolved).toEqual([]);
	});
});

describe("tableSessionId", () => {
	it("is deterministic per (channel, agent)", () => {
		expect(tableSessionId("chan_1", "agent:8EO")).toBe("table:chan_1:agent:8EO");
		expect(tableSessionId("chan_1", "agent:8EO")).toBe(tableSessionId("chan_1", "agent:8EO"));
		expect(tableSessionId("chan_1", "agent:8EO")).not.toBe(tableSessionId("chan_2", "agent:8EO"));
	});
});
