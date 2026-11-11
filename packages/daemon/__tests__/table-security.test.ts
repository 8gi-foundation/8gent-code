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

import { createPublicKey, generateKeyPairSync, randomBytes, sign as cryptoSign } from "node:crypto";
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
import { type DeviceRecord, rowSigningBytes, verifyP256Raw } from "../../table/store.js";
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
		// Desktop tools are gated as desktop_use (#3213); it is blocked too.
		expect(
			evaluatePolicy("desktop_use", { agentId: "__table__", action: "screenshot" }).allowed,
		).toBe(false);
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

// ── Slice 1a: the store's person lock ───────────────────────────────────────
// Vectors: table-security.vectors.json (generated locally with node:crypto, see its "source").
// Shared by the later signers (1d, 1e, 7), which must reproduce these results.

const VECTORS = JSON.parse(
	fs.readFileSync(path.join(import.meta.dir, "table-security.vectors.json"), "utf8"),
) as {
	row: Parameters<typeof rowSigningBytes>[0];
	bytesBase64: string;
	publicKeySpki: string;
	validSigRaw: string;
	highSTwinRaw: string;
	derSig: string;
	wrongCurve: { publicKeySpki: string };
};

const N_P256 = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const STORE_NAME = "8gi-forge";
const CLOCK = 1_762_819_200_000;

function makeDevice(participantId: string, deviceId: string, cls: DeviceRecord["class"] = "enclave") {
	const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const record: DeviceRecord = {
		deviceId,
		participantId,
		class: cls,
		publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
	};
	// Hash once, raw r||s: the exact call every platform signer makes.
	const signBytes = (b: Buffer) => cryptoSign("sha256", b, { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
	return { record, signBytes };
}

function lockedFixture() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "table-1a-"));
	const james = makeDevice("human:james", "dev-james");
	const artale = makeDevice("human:artale", "dev-artale");
	const devices: DeviceRecord[] = [james.record, artale.record];
	const ledger = Ledger.open({ runId: "table-1a", baseDir: path.join(tmp, "ledger"), key: randomBytes(32) });
	const store = new TableStore({
		dbPath: ":memory:",
		ledger,
		personLock: { storeName: STORE_NAME, devices: () => devices, now: () => CLOCK },
	});
	const channel = store.createChannel({ name: "ws-8gi--founders", type: "stream", visibility: "open", createdBy: "human:james" });
	for (const p of ["human:james", "human:artale", "human:local", "human:jamess", "human:officer-8eo", "human:game"]) {
		if (p !== "human:james") store.addMember({ channelId: channel.id, participantId: p, role: "member", addedBy: "human:james" });
	}
	const keyDir = { root: path.join(tmp, "keys") };
	const frame = (participantId: string | undefined, body: Record<string, unknown>) => {
		const state: TableRouteState = { subscribedChannels: new Set(), participantId, remoteAddress: "127.0.0.1" };
		const { deps, sent } = makeDeps(store, state);
		handleTableFrame(deps, { type: "message:post", id: 1, channelId: channel.id, ...body });
		return sent[0];
	};
	const signedPost = (dev: ReturnType<typeof makeDevice>, authorId: string, content: string, createdAt = CLOCK, replyTo?: string) => {
		const sig = dev.signBytes(
			rowSigningBytes({ storeName: STORE_NAME, deviceId: dev.record.deviceId, channelId: channel.id, authorId, content, replyTo, createdAt }),
		);
		return { content, sig, createdAt, deviceId: dev.record.deviceId, replyTo };
	};
	return { tmp, store, channel, james, artale, devices, keyDir, frame, signedPost };
}

describe("1a - shared P-256 vectors (raw r||s, SHA-256 once)", () => {
	const bytes = Buffer.from(VECTORS.bytesBase64, "base64");

	it("rowSigningBytes reproduces the vector bytes exactly", () => {
		expect(rowSigningBytes(VECTORS.row).equals(bytes)).toBe(true);
	});
	it("accepts the valid raw signature", () => {
		expect(verifyP256Raw(VECTORS.publicKeySpki, bytes, VECTORS.validSigRaw)).toBe(true);
	});
	it("the high-S twin is mathematically valid but is a different signature, never the same identifier", () => {
		expect(VECTORS.highSTwinRaw).not.toBe(VECTORS.validSigRaw);
		const s = BigInt("0x" + Buffer.from(VECTORS.validSigRaw, "base64").subarray(32).toString("hex"));
		const t = BigInt("0x" + Buffer.from(VECTORS.highSTwinRaw, "base64").subarray(32).toString("hex"));
		expect(s + t).toBe(N_P256);
		expect(verifyP256Raw(VECTORS.publicKeySpki, bytes, VECTORS.highSTwinRaw)).toBe(true);
	});
	it("refuses a DER signature", () => {
		expect(Buffer.from(VECTORS.derSig, "base64").length).not.toBe(64);
		expect(verifyP256Raw(VECTORS.publicKeySpki, bytes, VECTORS.derSig)).toBe(false);
	});
	it("refuses a key on the wrong curve, and altered bytes", () => {
		expect(verifyP256Raw(VECTORS.wrongCurve.publicKeySpki, bytes, VECTORS.validSigRaw)).toBe(false);
		expect(verifyP256Raw(VECTORS.publicKeySpki, Buffer.concat([bytes, Buffer.from("x")]), VECTORS.validSigRaw)).toBe(false);
		expect(createPublicKey({ key: Buffer.from(VECTORS.publicKeySpki, "base64"), format: "der", type: "spki" }).asymmetricKeyType).toBe("ec");
	});
	it("refuses a signature that is not canonical base64 of 64 bytes", () => {
		expect(verifyP256Raw(VECTORS.publicKeySpki, bytes, VECTORS.validSigRaw.slice(0, -4))).toBe(false);
		expect(verifyP256Raw(VECTORS.publicKeySpki, bytes, "")).toBe(false);
	});
	it("refuses a newline inside a non-content signed field", () => {
		expect(() => rowSigningBytes({ ...VECTORS.row, replyTo: "a\nb" })).toThrow();
	});
});

describe("1a - the store's lock on the live message:post path", () => {
	it("accepts a valid signed post and records the device, with the signed createdAt", () => {
		const f = lockedFixture();
		const reply = f.frame("human:james", f.signedPost(f.james, "human:james", "hello from james"));
		expect(reply.type).toBe("message:posted");
		const row = f.store.db.prepare("SELECT message_id, device_id, created_at FROM message_devices").get() as Record<string, unknown>;
		expect(row.device_id).toBe("dev-james");
		expect(row.created_at).toBe(CLOCK);
		expect(f.store.listMessages(f.channel.id, { viewerId: "human:james" })[0].createdAt).toBe(CLOCK);
		fs.rmSync(f.tmp, { recursive: true, force: true });
	});

	it("refuses an unsigned human:james post", () => {
		const f = lockedFixture();
		const reply = f.frame("human:james", { content: "no signature" });
		expect(reply.type).toBe("table:error");
		expect(reply.code).toBe("TABLE_AUTH");
		expect(f.store.listMessages(f.channel.id, { viewerId: "human:james" }).length).toBe(0);
		fs.rmSync(f.tmp, { recursive: true, force: true });
	});

	it("refuses human:local, human:jamess, an officer-shaped human id and no actor at all", () => {
		const f = lockedFixture();
		for (const who of ["human:local", "human:jamess", "human:officer-8eo", undefined]) {
			const reply = f.frame(who, f.signedPost(f.james, who ?? "human:local", "claim"));
			expect(reply.type).toBe("table:error");
			expect(reply.code).toBe("TABLE_AUTH");
		}
		expect(f.store.listMessages(f.channel.id, { viewerId: "human:james" }).length).toBe(0);
		fs.rmSync(f.tmp, { recursive: true, force: true });
	});

	it("refuses human:game outside the gate's GAME path, even though the frame is signed", () => {
		const f = lockedFixture();
		const reply = f.frame("human:game", f.signedPost(f.james, "human:game", "activity"));
		expect(reply.code).toBe("TABLE_AUTH");
		expect(f.store.postMessage({ channelId: f.channel.id, authorId: "human:game", content: "gate activity", gateActor: true }).authorId).toBe("human:game");
		fs.rmSync(f.tmp, { recursive: true, force: true });
	});

	it("a handle bound to one key cannot be claimed with another", () => {
		const f = lockedFixture();
		// Artale's valid key and signature, but claiming James's handle.
		const asJamesWithArtale = f.frame("human:james", f.signedPost(f.artale, "human:james", "i am james"));
		expect(asJamesWithArtale.code).toBe("TABLE_AUTH");
		// A valid signature from a key nobody enrolled.
		const stranger = makeDevice("human:james", "dev-stranger");
		expect(f.frame("human:james", f.signedPost(stranger, "human:james", "unenrolled")).code).toBe("TABLE_AUTH");
		// Same deviceId as James's, signed by a different key.
		const forged = makeDevice("human:james", "dev-james");
		expect(f.frame("human:james", f.signedPost(forged, "human:james", "forged")).code).toBe("TABLE_AUTH");
		// Each key still works for its own handle.
		expect(f.frame("human:artale", f.signedPost(f.artale, "human:artale", "artale here")).type).toBe("message:posted");
		fs.rmSync(f.tmp, { recursive: true, force: true });
	});

	it("an altered row does not verify under the original signature", () => {
		const f = lockedFixture();
		const p = f.signedPost(f.james, "human:james", "original words");
		expect(f.frame("human:james", { ...p, content: "different words" }).code).toBe("TABLE_AUTH");
		expect(f.frame("human:james", { ...p, createdAt: CLOCK + 1 }).code).toBe("TABLE_AUTH");
		fs.rmSync(f.tmp, { recursive: true, force: true });
	});

	it("refuses a DER-encoded signature on the live path", () => {
		const f = lockedFixture();
		const p = f.signedPost(f.james, "human:james", "der please");
		// Re-encode r||s as DER.
		const raw = Buffer.from(p.sig, "base64");
		const enc = (b: Buffer) => {
			let i = 0;
			while (i < b.length - 1 && b[i] === 0) i++;
			b = b.subarray(i);
			if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
			return Buffer.concat([Buffer.from([2, b.length]), b]);
		};
		const body = Buffer.concat([enc(raw.subarray(0, 32)), enc(raw.subarray(32))]);
		const der = Buffer.concat([Buffer.from([0x30, body.length]), body]).toString("base64");
		expect(f.frame("human:james", { ...p, sig: der }).code).toBe("TABLE_AUTH");
		expect(f.frame("human:james", p).type).toBe("message:posted");
		fs.rmSync(f.tmp, { recursive: true, force: true });
	});

	it("replay: the same signed row re-posted is refused, and its high-S twin is not a new row", () => {
		const f = lockedFixture();
		const p = f.signedPost(f.james, "human:james", "say it once");
		expect(f.frame("human:james", p).type).toBe("message:posted");
		const again = f.frame("human:james", p);
		expect(again.type).toBe("table:error");
		expect(again.code).toBe("TABLE_CONFLICT");
		// The twin: (r, n-s) is a different byte string that verifies over the same row.
		const raw = Buffer.from(p.sig, "base64");
		const s = BigInt("0x" + raw.subarray(32).toString("hex"));
		const twinS = Buffer.from((N_P256 - s).toString(16).padStart(64, "0"), "hex");
		const twin = Buffer.concat([raw.subarray(0, 32), twinS]).toString("base64");
		expect(twin).not.toBe(p.sig);
		const spki = f.james.record.publicKey;
		const bytes = rowSigningBytes({ storeName: STORE_NAME, deviceId: "dev-james", channelId: f.channel.id, authorId: "human:james", content: "say it once", createdAt: CLOCK });
		expect(verifyP256Raw(spki, bytes, twin)).toBe(true);
		const twinReply = f.frame("human:james", { ...p, sig: twin });
		expect(twinReply.code).toBe("TABLE_CONFLICT");
		expect(f.store.listMessages(f.channel.id, { viewerId: "human:james" }).length).toBe(1);
		fs.rmSync(f.tmp, { recursive: true, force: true });
	});

	it("refuses createdAt outside 60 s of the store's clock", () => {
		const f = lockedFixture();
		expect(f.frame("human:james", f.signedPost(f.james, "human:james", "late", CLOCK - 61_000)).code).toBe("TABLE_AUTH");
		expect(f.frame("human:james", f.signedPost(f.james, "human:james", "early", CLOCK + 61_000)).code).toBe("TABLE_AUTH");
		expect(f.frame("human:james", f.signedPost(f.james, "human:james", "edge", CLOCK - 60_000)).type).toBe("message:posted");
		fs.rmSync(f.tmp, { recursive: true, force: true });
	});

	it("device classes fail closed: browser is read-only, file only for human:desk, and a revoke is live", () => {
		const f = lockedFixture();
		const browser = makeDevice("human:james", "dev-browser", "browser");
		const file = makeDevice("human:james", "dev-file", "file");
		f.devices.push(browser.record, file.record);
		expect(f.frame("human:james", f.signedPost(browser, "human:james", "from browser")).code).toBe("TABLE_AUTH");
		expect(f.frame("human:james", f.signedPost(file, "human:james", "from file")).code).toBe("TABLE_AUTH");
		f.devices.splice(f.devices.indexOf(f.james.record), 1);
		expect(f.frame("human:james", f.signedPost(f.james, "human:james", "revoked")).code).toBe("TABLE_AUTH");
		fs.rmSync(f.tmp, { recursive: true, force: true });
	});

	it("never creates a person key: the key dir stays empty through a signed post, and bind with mintKey=false mints nothing", () => {
		const f = lockedFixture();
		f.frame("human:james", f.signedPost(f.james, "human:james", "no key minted"));
		const s: { participantId?: string } = {};
		expect(bindParticipant(s, "human:james", f.keyDir, false).ok).toBe(true);
		expect(fs.existsSync(f.keyDir.root) ? fs.readdirSync(f.keyDir.root).length : 0).toBe(0);
		fs.rmSync(f.tmp, { recursive: true, force: true });
	});

	it("officer (non-human) ids are not touched by the lock", () => {
		const f = lockedFixture();
		f.store.addMember({ channelId: f.channel.id, participantId: "agent:8to", role: "bot", addedBy: "human:james" });
		expect(f.store.postMessage({ channelId: f.channel.id, authorId: "agent:8to", content: "officer post" }).authorId).toBe("agent:8to");
		fs.rmSync(f.tmp, { recursive: true, force: true });
	});
});

describe("1a - today's behaviour is unchanged when no lock is configured", () => {
	it("an unlocked store still accepts an unsigned human:local post through message:post, adds no table and no column (the ed25519 path is covered by the F2 tests above)", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "table-1a-off-"));
		const store = freshStore(tmp);
		expect(store.hasPersonLock()).toBe(false);
		const ch = store.createChannel({ name: "ops", type: "stream", visibility: "open", createdBy: "human:local" });
		const state: TableRouteState = { subscribedChannels: new Set(), remoteAddress: "127.0.0.1" };
		const { deps, sent } = makeDeps(store, state);
		handleTableFrame(deps, { type: "message:post", id: 1, channelId: ch.id, content: "unsigned, as today" });
		expect(sent[0].type).toBe("message:posted");
		const m = store.listMessages(ch.id, { viewerId: "human:local" })[0];
		expect(m.authorId).toBe("human:local");
		expect(Math.abs(m.createdAt - Date.now())).toBeLessThan(5_000);
		const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message_devices'").all() as unknown[]).length;
		expect(tables).toBe(0);
		const cols = (store.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((c) => c.name);
		expect(cols).toEqual(["id", "channel_id", "author_id", "content", "reply_to", "sig", "edited_at", "deleted_at", "created_at", "audio_url", "audio_duration_ms"]);
		store.close();
		fs.rmSync(tmp, { recursive: true, force: true });
	});
});
