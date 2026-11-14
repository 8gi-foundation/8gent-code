/**
 * table-server, end to end: the real entry (main.ts) in a child process, over
 * a copy of a real-shaped table.db built with TableStore itself (never the
 * live ~/.8gent/table, which holds private messages), driven with the exact
 * frames ~/.8gent/bin/table-gate sends.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTempDirs, tempDir } from "../../../tests/temp-dirs";
import { Ledger } from "../../../packages/goal/ledger";
import { TableStore } from "../../../packages/table/store";
import { walkImports } from "./import-graph";

const MAIN = path.join(import.meta.dir, "main.ts");
const TOKEN = randomBytes(24).toString("hex");

/** Build a data dir the way the daemon lays one out: keys/, table/table.db, table/ledger/ledger.jsonl. */
function buildFixture(dir: string): { key: Buffer } {
	const key = randomBytes(32);
	fs.mkdirSync(path.join(dir, "keys"), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(dir, "keys", "state-hmac.key"), key, { mode: 0o600 });
	const ledger = Ledger.open({ runId: "ledger", baseDir: path.join(dir, "table"), key });
	const store = new TableStore({ dbPath: path.join(dir, "table", "table.db"), ledger });
	const owner = "human:local";
	const general = store.createChannel({
		name: "ws-8gi--general",
		type: "stream",
		visibility: "open",
		createdBy: owner,
	});
	const dept = store.createChannel({
		name: "ws-8gi--dept-8to",
		type: "stream",
		visibility: "private",
		createdBy: owner,
	});
	const old = store.createChannel({
		name: "ws-8gi--old",
		type: "stream",
		visibility: "open",
		createdBy: owner,
	});
	store.addMember({
		channelId: general.id,
		participantId: "human:8to",
		role: "member",
		addedBy: owner,
	});
	store.addMember({
		channelId: dept.id,
		participantId: "human:8to",
		role: "member",
		addedBy: owner,
	});
	for (let i = 0; i < 5; i++)
		store.postMessage({ channelId: general.id, authorId: owner, content: `fixture ${i}` });
	store.postMessage({ channelId: dept.id, authorId: "human:8to", content: "dept only" });
	store.archiveChannel(old.id, owner);
	store.close();
	ledger.close();
	return { key };
}

function writeToken(dir: string, value: string, mode = 0o600): string {
	const file = path.join(dir, "token");
	fs.writeFileSync(file, value, { mode });
	fs.chmodSync(file, mode);
	return file;
}

interface Running {
	proc: ReturnType<typeof Bun.spawn>;
	port: number;
}

async function startServer(
	dataDir: string,
	tokenFile: string | undefined,
	extraArgs: string[] = [],
): Promise<Running | { exit: number; err: string }> {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		EIGHT_DATA_DIR: dataDir,
		TABLE_PORT: "0",
	};
	if (tokenFile) env.TABLE_TOKEN_FILE = tokenFile;
	// cwd outside the data dir: goal-state-hmac refuses a key inside the project directory.
	const proc = Bun.spawn([process.execPath, MAIN, ...extraArgs], {
		cwd: tempDir("table-server-cwd-"),
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
	let out = "";
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const race = await Promise.race([
			reader.read(),
			proc.exited.then(() => ({ done: true, value: undefined })),
		]);
		if (race.value) out += new TextDecoder().decode(race.value);
		const m = out.match(/listening on 127\.0\.0\.1:(\d+)/);
		if (m) {
			reader.releaseLock();
			return { proc, port: Number(m[1]) };
		}
		if (race.done) break;
	}
	const exit = await proc.exited;
	return { exit, err: await new Response(proc.stderr as ReadableStream).text() };
}

/** A tiny client with table-gate's _ask: send a frame, wait for the reply with that id and type. */
class Client {
	private frames: Record<string, unknown>[] = [];
	private waiters: (() => void)[] = [];
	closed = false;
	private constructor(private ws: WebSocket) {
		ws.onmessage = (e) => {
			this.frames.push(JSON.parse(String(e.data)));
			for (const w of this.waiters.splice(0)) w();
		};
		ws.onclose = () => {
			this.closed = true;
			for (const w of this.waiters.splice(0)) w();
		};
	}
	static async open(port: number): Promise<Client> {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		await new Promise<void>((res, rej) => {
			ws.onopen = () => res();
			ws.onerror = () => rej(new Error("ws open failed"));
		});
		return new Client(ws);
	}
	send(frame: Record<string, unknown>): void {
		this.ws.send(JSON.stringify(frame));
	}
	async next(
		match: (f: Record<string, unknown>) => boolean,
		ms = 5000,
	): Promise<Record<string, unknown>> {
		const deadline = Date.now() + ms;
		for (;;) {
			const i = this.frames.findIndex(match);
			if (i >= 0) return this.frames.splice(i, 1)[0] as Record<string, unknown>;
			if (this.closed) throw new Error("closed");
			if (Date.now() > deadline) throw new Error("timeout");
			await new Promise<void>((r) => {
				this.waiters.push(r);
				setTimeout(r, 100);
			});
		}
	}
	async ask(frame: Record<string, unknown>, want: string): Promise<Record<string, unknown>> {
		this.send(frame);
		const got = await this.next(
			(f) => f.id === frame.id && (f.type === want || f.type === "table:error"),
		);
		if (got.type === "table:error")
			throw Object.assign(new Error(String(got.message)), { code: got.code });
		return got;
	}
	async auth(participantId: string, token = TOKEN): Promise<string> {
		this.send({ type: "auth", token, participantId });
		return String((await this.next((f) => f.type === "auth:ok" || f.type === "auth:fail")).type);
	}
	close(): void {
		this.ws.close();
	}
}

async function channelIds(c: Client, includeArchived = true): Promise<Record<string, string>> {
	const listed = await c.ask({ type: "channel:list", id: "L", includeArchived }, "channel:listed");
	return Object.fromEntries(
		(listed.channels as { name: string; id: string }[]).map((ch) => [ch.name, ch.id]),
	);
}

let fixtureDir: string;
let dataDir: string;
let key: Buffer;
let tokenFile: string;
let server: Running;

beforeAll(async () => {
	fixtureDir = tempDir("table-server-fixture-");
	({ key } = buildFixture(fixtureDir));
	// The server opens a COPY of the real-shaped store, as the cutover will.
	dataDir = tempDir("table-server-data-");
	fs.cpSync(fixtureDir, dataDir, { recursive: true });
	tokenFile = writeToken(tempDir("table-server-secret-"), TOKEN);
	const started = await startServer(dataDir, tokenFile);
	if (!("port" in started)) throw new Error(`server did not start: ${started.err}`);
	server = started;
});

afterAll(async () => {
	server?.proc.kill("SIGTERM");
	await server?.proc.exited;
	cleanupTempDirs();
});

describe("table-server over a copy of a real-shaped table.db", () => {
	test("healthz reports the store's channel, member and message counts", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, number | boolean>;
		// 3 channels; members = 3 owners (creator) + 2 added; 6 messages.
		const ref = new TableStore({
			dbPath: path.join(fixtureDir, "table", "table.db"),
			ledger: Ledger.open({ runId: "ledger", baseDir: path.join(fixtureDir, "table"), key }),
		});
		const want = {
			channels: ref.listChannels({ includeArchived: true }).length,
			members: (ref.db.prepare("SELECT COUNT(*) AS n FROM members").get() as { n: number }).n,
		};
		ref.close();
		expect(body.ok).toBe(true);
		expect(body.channels).toBe(want.channels);
		expect(body.channels).toBe(3);
		expect(body.members).toBe(want.members);
		expect(body.messages).toBeGreaterThanOrEqual(6);
	});

	test("lists the fixture channels with the gate's frames, archived only on request, private only to members", async () => {
		const c = await Client.open(server.port);
		expect(await c.auth("human:8to")).toBe("auth:ok");
		const all = await channelIds(c, true);
		expect(Object.keys(all).sort()).toEqual(["ws-8gi--dept-8to", "ws-8gi--general", "ws-8gi--old"]);
		expect(Object.keys(await channelIds(c, false))).not.toContain("ws-8gi--old");
		c.close();

		const outsider = await Client.open(server.port);
		expect(await outsider.auth("human:8po")).toBe("auth:ok");
		expect(Object.keys(await channelIds(outsider))).not.toContain("ws-8gi--dept-8to");
		outsider.close();
	});

	test("post then read back, and subscribers get message:appended", async () => {
		const c = await Client.open(server.port);
		expect(await c.auth("human:8to")).toBe("auth:ok");
		const ids = await channelIds(c);
		const general = ids["ws-8gi--general"] as string;
		const sub = await c.ask(
			{ type: "message:subscribe", id: "R", channelId: general, seed: 200 },
			"message:subscribed",
		);
		expect((sub.backlog as unknown[]).length).toBe(5);

		const content = `hello from the box ${Date.now()}`;
		const posted = await c.ask(
			{ type: "message:post", id: "P", channelId: general, content },
			"message:posted",
		);
		const msg = posted.message as { id: string; authorId: string; content: string };
		expect(msg.authorId).toBe("human:8to");
		expect(msg.content).toBe(content);
		const appended = await c.next((f) => f.type === "message:appended");
		expect((appended.message as { id: string }).id).toBe(msg.id);
		c.close();

		const reader = await Client.open(server.port);
		expect(await reader.auth("human:local")).toBe("auth:ok");
		const back = await reader.ask(
			{ type: "message:subscribe", id: "R", channelId: general, seed: 200 },
			"message:subscribed",
		);
		const found = (back.backlog as { id: string; content: string; createdAt: number }[]).find(
			(m) => m.id === msg.id,
		);
		expect(found?.content).toBe(content);
		expect(typeof found?.createdAt).toBe("number");
		reader.close();
	});

	test("channel:members add, list and the store's own membership rule for posts", async () => {
		const owner = await Client.open(server.port);
		expect(await owner.auth("human:local")).toBe("auth:ok");
		const dept = (await channelIds(owner))["ws-8gi--dept-8to"] as string;
		await owner.ask(
			{
				type: "channel:members",
				id: "M",
				op: "add",
				channelId: dept,
				participantId: "human:game",
				role: "member",
			},
			"channel:memberAdded",
		);
		await expect(
			owner.ask(
				{
					type: "channel:members",
					id: "M2",
					op: "add",
					channelId: dept,
					participantId: "human:game",
					role: "member",
				},
				"channel:memberAdded",
			),
		).rejects.toMatchObject({ code: "TABLE_CONFLICT" });
		const listed = await owner.ask(
			{ type: "channel:members", id: "ML", channelId: dept },
			"channel:membersList",
		);
		expect((listed.members as { participantId: string }[]).map((m) => m.participantId)).toContain(
			"human:game",
		);
		owner.close();

		const outsider = await Client.open(server.port);
		expect(await outsider.auth("human:8po")).toBe("auth:ok");
		await expect(
			outsider.ask(
				{ type: "message:post", id: "P", channelId: dept, content: "x" },
				"message:posted",
			),
		).rejects.toHaveProperty("code");
		await expect(
			outsider.ask({ type: "channel:members", id: "ML", channelId: dept }, "channel:membersList"),
		).rejects.toHaveProperty("code");
		outsider.close();
	});

	test("refuses frames outside the subset, and signed posts", async () => {
		const c = await Client.open(server.port);
		expect(await c.auth("human:local")).toBe("auth:ok");
		await expect(
			c.ask({ type: "channel:archive", id: "A", channelId: "x" }, "channel:archived"),
		).rejects.toMatchObject({ code: "TABLE_UNSUPPORTED" });
		await expect(
			c.ask({ type: "session:create", id: "S" }, "session:created"),
		).rejects.toMatchObject({ code: "TABLE_UNSUPPORTED" });
		const general = (await channelIds(c))["ws-8gi--general"] as string;
		await expect(
			c.ask(
				{ type: "message:post", id: "P", channelId: general, content: "x", sig: "AAAA" },
				"message:posted",
			),
		).rejects.toMatchObject({ code: "TABLE_VALIDATION" });
		c.close();
	});
});

describe("auth fails closed", () => {
	test("a wrong token gets auth:fail and the socket closes", async () => {
		const c = await Client.open(server.port);
		expect(await c.auth("human:local", "not-the-token")).toBe("auth:fail");
		await c.next(() => false, 2000).catch(() => {});
		expect(c.closed).toBe(true);
	});

	test("an agent or malformed participant is refused even with the right token", async () => {
		for (const pid of ["agent:8to", "human:", "local", "human:a b"]) {
			const c = await Client.open(server.port);
			expect(await c.auth(pid)).toBe("auth:fail");
		}
	});

	test("a frame before auth closes the socket without touching the store", async () => {
		const c = await Client.open(server.port);
		c.send({ type: "channel:list", id: "L" });
		const err = await c.next((f) => f.type === "error");
		expect(err.message).toBe("not authenticated");
		await c.next(() => false, 2000).catch(() => {});
		expect(c.closed).toBe(true);
	});

	test("the identity is pinned: a second auth as someone else fails", async () => {
		const c = await Client.open(server.port);
		expect(await c.auth("human:8to")).toBe("auth:ok");
		expect(await c.auth("human:local")).toBe("auth:fail");
	});
});

describe("startup refusals", () => {
	test("no TABLE_TOKEN_FILE, a loose token file, or a short token: exit 2", async () => {
		const d = tempDir("table-server-refuse-");
		fs.cpSync(fixtureDir, d, { recursive: true });
		const none = await startServer(d, undefined);
		expect(none).toMatchObject({ exit: 2 });
		const loose = await startServer(d, writeToken(tempDir("table-server-loose-"), TOKEN, 0o644));
		expect(loose).toMatchObject({ exit: 2 });
		const short = await startServer(d, writeToken(tempDir("table-server-short-"), "abc"));
		expect(short).toMatchObject({ exit: 2 });
	});

	test("a missing ledger key is an error unless --init-key is passed", async () => {
		const fresh = tempDir("table-server-fresh-");
		const refused = await startServer(fresh, tokenFile);
		expect(refused).toMatchObject({ exit: 2 });
		expect((refused as { err: string }).err).toContain("--init-key");
		expect(fs.existsSync(path.join(fresh, "keys", "state-hmac.key"))).toBe(false);
		const started = await startServer(fresh, tokenFile, ["--init-key"]);
		expect("port" in started).toBe(true);
		if ("port" in started) {
			started.proc.kill("SIGTERM");
			await started.proc.exited;
		}
		expect(fs.statSync(path.join(fresh, "keys", "state-hmac.key")).mode & 0o777).toBe(0o600);
	});

	test("a tampered ledger refuses to start", async () => {
		const d = tempDir("table-server-tamper-");
		fs.cpSync(fixtureDir, d, { recursive: true });
		const file = path.join(d, "table", "ledger", "ledger.jsonl");
		const lines = fs.readFileSync(file, "utf8").trim().split("\n");
		const first = JSON.parse(lines[0] as string);
		first.payload = { ...first.payload, tampered: true };
		lines[0] = JSON.stringify(first);
		fs.writeFileSync(file, `${lines.join("\n")}\n`);
		const r = await startServer(d, tokenFile);
		expect(r).toMatchObject({ exit: 2 });
		expect((r as { err: string }).err).toContain("ledger does not verify");
	});
});

describe("the ledger after the server's mutations", () => {
	test("verifies, and grew by the posts and member adds made above", async () => {
		const before = Ledger.open({ runId: "ledger", baseDir: path.join(fixtureDir, "table"), key });
		const base = before.verify();
		before.close();
		const after = Ledger.open({ runId: "ledger", baseDir: path.join(dataDir, "table"), key });
		const now = after.verify();
		after.close();
		expect(base.ok).toBe(true);
		expect(now.ok).toBe(true);
		// one post + one member add happened through the server
		expect(now.count).toBeGreaterThanOrEqual(base.count + 2);
	});
});

describe("import graph", () => {
	test("the server's entry never loads node:child_process", () => {
		const g = walkImports(MAIN);
		const banned = [...g.external.keys()].filter(
			(s) => s === "child_process" || s === "node:child_process",
		);
		expect(banned).toEqual([]);
		const names = [...g.files].map((f) => path.basename(f));
		expect(names).toContain("store.ts");
		expect(names).toContain("goal-state-hmac.ts");
		expect(names).not.toContain("run-command-sandbox.ts");
		expect(names).not.toContain("seatbelt.ts");
	});

	test("control: the walker does see child_process where it is imported", () => {
		const g = walkImports(
			path.join(import.meta.dir, "../../../packages/permissions/run-command-sandbox.ts"),
		);
		expect(g.external.has("node:child_process")).toBe(true);
	});
});
