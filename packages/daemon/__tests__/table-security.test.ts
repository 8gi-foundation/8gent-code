/**
 * Table security hardening tests (8SO bar).
 *
 * Proves the four adversarial-review fixes are actually enforced on the live
 * daemon path (not just at the store layer):
 *   F1 - a Table frame from a non-loopback peer is rejected before any store access.
 *   F2 - a connection is PINNED to one verified human participant; it cannot
 *        re-bind, cannot declare an agent id, and cannot post as anyone else.
 *   F3 - term_* orchestration and computer/desktop control are gated and BLOCKED
 *        for the __table__ scope (and unaffected for other scopes).
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import { Ledger } from "../../goal/ledger.js";
import { evaluatePolicy } from "../../permissions/policy-engine.js";
import { ToolExecutor } from "../../eight/tools.js";
import {
	TableStore,
	canonicalMessage,
	installTablePolicies,
	signMessage,
} from "../../table/index.js";
import {
	type TableRouteDeps,
	type TableRouteState,
	bindParticipant,
	handleTableFrame,
	isLoopbackAddress,
} from "../table-routes.js";

// Isolate ALL default-keydir / audit writes into a throwaway dir so the live
// route path (which uses defaultKeyDir()) can find keys minted here and nothing
// touches the real ~/.8gent.
const DATA_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "table-datadir-"));
process.env.EIGHT_DATA_DIR = DATA_TMP;

installTablePolicies();

function freshStore(tmp: string): TableStore {
	const ledger = Ledger.open({
		runId: "table-sec",
		baseDir: path.join(tmp, "ledger"),
		key: randomBytes(32),
	});
	return new TableStore({ dbPath: ":memory:", ledger });
}

function makeDeps(store: TableStore, state: TableRouteState): {
	deps: TableRouteDeps;
	sent: Array<Record<string, unknown>>;
	appended: Array<Record<string, unknown>>;
} {
	const sent: Array<Record<string, unknown>> = [];
	const appended: Array<Record<string, unknown>> = [];
	const deps: TableRouteDeps = {
		store,
		// pool is only touched by the (human+mention) flow, which none of these
		// tests trigger; a stub keeps the surface honest.
		pool: {} as TableRouteDeps["pool"],
		broadcast: (_c, frame) => appended.push(frame as Record<string, unknown>),
		sendRaw: (frame) => sent.push(frame as Record<string, unknown>),
		state,
	};
	return { deps, sent, appended };
}

describe("F1 - Table is loopback-only per-frame", () => {
	it("classifies loopback vs non-loopback addresses (fail closed on empty)", () => {
		expect(isLoopbackAddress("127.0.0.1")).toBe(true);
		expect(isLoopbackAddress("::1")).toBe(true);
		expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
		expect(isLoopbackAddress("10.0.0.5")).toBe(false);
		expect(isLoopbackAddress("192.168.1.20")).toBe(false);
		expect(isLoopbackAddress(undefined)).toBe(false);
		expect(isLoopbackAddress("")).toBe(false);
	});

	it("rejects a channel:create frame from a non-loopback peer before touching the store", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "table-f1-"));
		const store = freshStore(tmp);
		const state: TableRouteState = {
			subscribedChannels: new Set(),
			participantId: "human:remote",
			remoteAddress: "203.0.113.7",
		};
		const { deps, sent } = makeDeps(store, state);

		const handled = handleTableFrame(deps, {
			type: "channel:create",
			id: 1,
			name: "evil",
			channelType: "stream",
			visibility: "open",
		});

		expect(handled).toBe(true);
		expect(sent.length).toBe(1);
		expect(sent[0].type).toBe("table:error");
		expect(sent[0].code).toBe("TABLE_FORBIDDEN");
		// Nothing was written.
		expect(store.listChannels().length).toBe(0);
		store.close();
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("allows the identical frame from a loopback peer", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "table-f1ok-"));
		const store = freshStore(tmp);
		const state: TableRouteState = {
			subscribedChannels: new Set(),
			participantId: "human:local",
			remoteAddress: "127.0.0.1",
		};
		const { deps, sent } = makeDeps(store, state);
		handleTableFrame(deps, {
			type: "channel:create",
			id: 2,
			name: "ops",
			channelType: "stream",
			visibility: "open",
		});
		expect(sent[0].type).toBe("channel:created");
		expect(store.listChannels().length).toBe(1);
		store.close();
		fs.rmSync(tmp, { recursive: true, force: true });
	});
});

describe("F2 - connection is pinned to one verified human participant", () => {
	it("pins a human id, refuses re-bind and agent/malformed ids, and mints the key", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "table-f2-"));
		const keyDir = { root: path.join(tmp, "keys") };

		const s: { participantId?: string } = {};
		expect(bindParticipant(s, "human:alice", keyDir).ok).toBe(true);
		expect(s.participantId).toBe("human:alice");
		// key material was actually custodied on the live path.
		expect(fs.existsSync(path.join(keyDir.root, "alice.ed25519.pub"))).toBe(true);

		// Cannot switch identity on the same connection.
		const reBind = bindParticipant(s, "human:bob", keyDir);
		expect(reBind.ok).toBe(false);
		expect(s.participantId).toBe("human:alice");

		// Agent impersonation is refused outright.
		expect(bindParticipant({}, "agent:8EO", keyDir).ok).toBe(false);
		// Malformed / unnamespaced is refused.
		expect(bindParticipant({}, "alice", keyDir).ok).toBe(false);
		expect(bindParticipant({}, "", keyDir).ok).toBe(false);

		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("a connection can only post as its pinned participant, and a bad signature is refused", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "table-f2post-"));
		const store = freshStore(tmp);

		// Alice binds (default keydir = EIGHT_DATA_DIR temp, which the route's
		// verifyMessage also reads) and creates a channel (auto-owner/member).
		const alice: TableRouteState = {
			subscribedChannels: new Set(),
			remoteAddress: "127.0.0.1",
		};
		expect(bindParticipant(alice, "human:alice").ok).toBe(true);
		const { deps, sent, appended } = makeDeps(store, alice);
		handleTableFrame(deps, {
			type: "channel:create",
			id: 1,
			name: "room",
			channelType: "stream",
			visibility: "open",
		});
		const created = sent.find((f) => f.type === "channel:created");
		const channelId = (created?.channel as { id: string }).id;

		// Plain (unsigned) post: author is the PINNED participant, never client-chosen.
		handleTableFrame(deps, { type: "message:post", id: 2, channelId, content: "hello from alice" });
		const posted = appended.find((f) => f.type === "message:appended");
		expect((posted?.message as { authorId: string }).authorId).toBe("human:alice");

		// A tampered signature must be refused (verifyMessage exercised live).
		const createdAt = Date.now();
		handleTableFrame(deps, {
			type: "message:post",
			id: 3,
			channelId,
			content: "signed but forged",
			createdAt,
			sig: Buffer.from("not-a-real-signature").toString("base64"),
		});
		const authErr = sent.find((f) => f.type === "table:error" && f.code === "TABLE_AUTH");
		expect(authErr).toBeTruthy();

		// A correctly-signed post by the pinned participant verifies and is stored.
		const okAt = Date.now();
		const canon = canonicalMessage({
			channelId,
			authorId: "human:alice",
			content: "signed and valid",
			createdAt: okAt,
		});
		const sig = signMessage("human:alice", canon);
		const before = store.listMessages(channelId, { viewerId: "human:alice" }).length;
		handleTableFrame(deps, {
			type: "message:post",
			id: 4,
			channelId,
			content: "signed and valid",
			createdAt: okAt,
			sig,
		});
		const after = store.listMessages(channelId, { viewerId: "human:alice" }).length;
		expect(after).toBe(before + 1);

		store.close();
		fs.rmSync(tmp, { recursive: true, force: true });
	});
});

describe("F3 - term_* and computer/desktop tools are gated for __table__", () => {
	it("blocks the new action classes for __table__ but not for other scopes", () => {
		expect(evaluatePolicy("term_orchestration", { agentId: "__table__" }).allowed).toBe(false);
		expect(evaluatePolicy("computer_use", { agentId: "__table__" }).allowed).toBe(false);
		// Scope isolation: an ordinary agent is unaffected (no default rule).
		expect(evaluatePolicy("term_orchestration", { agentId: "agent:normal" }).allowed).toBe(true);
		expect(evaluatePolicy("computer_use", { agentId: "agent:normal" }).allowed).toBe(true);
	});

	it("ToolExecutor blocks term_* and desktop_* for a __table__ agent end-to-end", async () => {
		const exec = new ToolExecutor(os.tmpdir(), "__table__");
		const term = await exec.execute("term_spawn", { command: "echo hi" });
		expect(term).toContain("[TOOLG8 BLOCKED]");
		const desktop = await exec.execute("desktop_screenshot", {});
		expect(desktop).toContain("[TOOLG8 BLOCKED]");
	});
});
