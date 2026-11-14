/**
 * table-server, end to end: the real entry (main.ts) in a child process, over
 * a copy of a real-shaped table.db built with TableStore itself (never the
 * live ~/.8gent/table, which holds private messages), driven with the frames
 * ~/.8gent/bin/table-gate sends.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Ledger, type LedgerEntry } from "../../../packages/goal/ledger";
import { TableStore } from "../../../packages/table/store";
import { cleanupTempDirs, tempDir } from "../../../tests/temp-dirs";
import { walkImports } from "./import-graph";
import { identityFor, MAX_CONTENT_BYTES, parseTokens, POST_BURST, takePost } from "./server";

const MAIN = path.join(import.meta.dir, "main.ts");
const tok = () => randomBytes(24).toString("hex");
const T = { "8to": tok(), local: tok(), "8po": tok(), game: tok() };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Build a data dir the way the daemon lays one out: keys/, table/table.db, table/ledger/ledger.jsonl. */
function buildFixture(dir: string): { key: Buffer } {
	const key = randomBytes(32);
	fs.mkdirSync(path.join(dir, "keys"), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(dir, "keys", "state-hmac.key"), key, { mode: 0o600 });
	const ledger = Ledger.open({ runId: "ledger", baseDir: path.join(dir, "table"), key });
	const store = new TableStore({ dbPath: path.join(dir, "table", "table.db"), ledger });
	const owner = "human:local";
	const mk = (name: string, visibility: "open" | "private") =>
		store.createChannel({ name, type: "stream", visibility, createdBy: owner });
	const general = mk("ws-8gi--general", "open");
	const dept = mk("ws-8gi--dept-8to", "private");
	const old = mk("ws-8gi--old", "open");
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

function writeSecret(dir: string, name: string, value: string | Buffer, mode = 0o600): string {
	const file = path.join(dir, name);
	fs.writeFileSync(file, value, { mode });
	fs.chmodSync(file, mode);
	return file;
}

function tokensText(): string {
	return `# test identities\n${Object.entries(T)
		.map(([who, t]) => `${sha(t)} human:${who}`)
		.join("\n")}\n`;
}

interface Running {
	proc: ReturnType<typeof Bun.spawn>;
	port: number;
}

async function startServer(
	dataDir: string,
	tokensFile: string | undefined,
	extraArgs: string[] = [],
	extraEnv: Record<string, string> = {},
): Promise<Running | { exit: number; err: string }> {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		EIGHT_DATA_DIR: dataDir,
		TABLE_PORT: "0",
		...extraEnv,
	};
	if (tokensFile) env.TABLE_TOKENS_FILE = tokensFile;
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

async function stopServer(r: Running): Promise<void> {
	r.proc.kill("SIGTERM");
	await r.proc.exited;
}

/** A tiny client with table-gate's _ask: send a frame, wait for the reply with that id and type. */
class Client {
	private frames: Record<string, unknown>[] = [];
	private waiters: (() => void)[] = [];
	closed = false;
	closeCode = 0;
	private constructor(private ws: WebSocket) {
		ws.onmessage = (e) => {
			this.frames.push(JSON.parse(String(e.data)));
			for (const w of this.waiters.splice(0)) w();
		};
		ws.onclose = (e) => {
			this.closed = true;
			this.closeCode = e.code;
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
	sendRaw(data: string): void {
		this.ws.send(data);
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
				setTimeout(r, 50);
			});
		}
	}
	async waitClosed(ms = 3000): Promise<boolean> {
		await this.next(() => false, ms).catch(() => {});
		return this.closed;
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
	/** table-gate's auth frame: the token plus the identity it declares. */
	async auth(token: string, participantId?: string): Promise<Record<string, unknown>> {
		const frame: Record<string, unknown> = { type: "auth", token };
		if (participantId !== undefined) frame.participantId = participantId;
		this.send(frame);
		return this.next((f) => f.type === "auth:ok" || f.type === "auth:fail");
	}
	close(): void {
		this.ws.close();
	}
}

async function as(port: number, who: keyof typeof T): Promise<Client> {
	const c = await Client.open(port);
	const r = await c.auth(T[who], `human:${who}`);
	if (r.type !== "auth:ok") throw new Error(`auth as ${who} failed`);
	return c;
}

async function channelIds(c: Client, includeArchived = true): Promise<Record<string, string>> {
	const listed = await c.ask({ type: "channel:list", id: "L", includeArchived }, "channel:listed");
	return Object.fromEntries(
		(listed.channels as { name: string; id: string }[]).map((ch) => [ch.name, ch.id]),
	);
}

function ledgerEntries(dir: string): LedgerEntry[] {
	const file = path.join(dir, "table", "ledger", "ledger.jsonl");
	return fs
		.readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as LedgerEntry);
}

let fixtureDir: string;
let dataDir: string;
let key: Buffer;
let secretDir: string;
let tokensFile: string;
let server: Running;

beforeAll(async () => {
	fixtureDir = tempDir("table-server-fixture-");
	({ key } = buildFixture(fixtureDir));
	// The server opens a COPY of the real-shaped store, as the cutover will.
	dataDir = tempDir("table-server-data-");
	fs.cpSync(fixtureDir, dataDir, { recursive: true });
	secretDir = tempDir("table-server-secret-");
	tokensFile = writeSecret(secretDir, "tokens", tokensText());
	const started = await startServer(dataDir, tokensFile);
	if (!("port" in started)) throw new Error(`server did not start: ${started.err}`);
	server = started;
});

afterAll(async () => {
	if (server) await stopServer(server);
	cleanupTempDirs();
});

describe("table-server over a copy of a real-shaped table.db", () => {
	test("healthz reports the store's channel, member and message counts", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, number | boolean>;
		const ref = new TableStore({
			dbPath: path.join(fixtureDir, "table", "table.db"),
			ledger: Ledger.open({ runId: "ledger", baseDir: path.join(fixtureDir, "table"), key }),
		});
		const members = (ref.db.prepare("SELECT COUNT(*) AS n FROM members").get() as { n: number }).n;
		ref.close();
		expect(body.ok).toBe(true);
		expect(body.channels).toBe(3);
		expect(body.members).toBe(members);
		expect(body.messages).toBeGreaterThanOrEqual(6);
	});

	test("lists the fixture channels, archived only on request, private only to members", async () => {
		const c = await as(server.port, "8to");
		expect(Object.keys(await channelIds(c, true)).sort()).toEqual([
			"ws-8gi--dept-8to",
			"ws-8gi--general",
			"ws-8gi--old",
		]);
		expect(Object.keys(await channelIds(c, false))).not.toContain("ws-8gi--old");
		c.close();
		const outsider = await as(server.port, "8po");
		expect(Object.keys(await channelIds(outsider))).not.toContain("ws-8gi--dept-8to");
		outsider.close();
	});

	test("post then read back, and subscribers get message:appended", async () => {
		const c = await as(server.port, "8to");
		const general = (await channelIds(c))["ws-8gi--general"] as string;
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
		const appended = await c.next((f) => f.type === "message:appended");
		expect((appended.message as { id: string }).id).toBe(msg.id);
		c.close();

		const reader = await as(server.port, "local");
		const back = await reader.ask(
			{ type: "message:subscribe", id: "R", channelId: general, seed: 200 },
			"message:subscribed",
		);
		const found = (back.backlog as { id: string; content: string }[]).find((m) => m.id === msg.id);
		expect(found?.content).toBe(content);
		reader.close();
	});

	test("channel:members add, list, and the store's membership rule for posts", async () => {
		const owner = await as(server.port, "local");
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

		const outsider = await as(server.port, "8po");
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
		const c = await as(server.port, "local");
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

describe("identity comes from the token, never the client", () => {
	test("8TO's token claiming human:local is refused and the socket closes", async () => {
		const c = await Client.open(server.port);
		expect((await c.auth(T["8to"], "human:local")).type).toBe("auth:fail");
		expect(await c.waitClosed()).toBe(true);
	});

	test("8TO's token with no claim binds to human:8to, and the post and ledger record human:8to", async () => {
		const c = await Client.open(server.port);
		const ok = await c.auth(T["8to"]);
		expect(ok).toMatchObject({ type: "auth:ok", participantId: "human:8to" });
		const general = (await channelIds(c))["ws-8gi--general"] as string;
		const posted = await c.ask(
			{ type: "message:post", id: "P", channelId: general, content: "who am I" },
			"message:posted",
		);
		const msg = posted.message as { id: string; authorId: string };
		expect(msg.authorId).toBe("human:8to");
		const entry = ledgerEntries(dataDir).find((e) => e.payload.messageId === msg.id);
		expect(entry?.kind).toBe("table.message.post");
		expect(entry?.payload.authorId).toBe("human:8to");
		c.close();
	});

	test("member adds record the token's identity as addedBy in the ledger", async () => {
		// 8PO is no admin of general: the store refuses, and nothing is recorded as anyone else.
		const c = await Client.open(server.port);
		await c.auth(T["8po"]);
		const general = (await channelIds(c))["ws-8gi--general"] as string;
		const before = ledgerEntries(dataDir).length;
		await expect(
			c.ask(
				{
					type: "channel:members",
					id: "M",
					op: "add",
					channelId: general,
					participantId: "human:x",
				},
				"channel:memberAdded",
			),
		).rejects.toHaveProperty("code");
		expect(ledgerEntries(dataDir).length).toBe(before);
		c.close();
	});

	test("a wrong token, a second auth, and an agent claim all fail", async () => {
		const wrong = await Client.open(server.port);
		expect((await wrong.auth("not-the-token", "human:local")).type).toBe("auth:fail");
		expect(await wrong.waitClosed()).toBe(true);

		const twice = await Client.open(server.port);
		expect((await twice.auth(T["8to"], "human:8to")).type).toBe("auth:ok");
		expect((await twice.auth(T.local, "human:local")).type).toBe("auth:fail");

		const agent = await Client.open(server.port);
		expect((await agent.auth(T["8to"], "agent:8to")).type).toBe("auth:fail");
	});

	test("unit: identityFor checks every entry and parseTokens rejects bad lines", () => {
		const entries = parseTokens(tokensText());
		expect(identityFor(T.game, entries)).toBe("human:game");
		expect(identityFor("nope", entries)).toBeUndefined();
		expect(identityFor(undefined, entries)).toBeUndefined();
		expect(() => parseTokens("abc human:x\n")).toThrow();
		expect(() => parseTokens(`${sha("a")} agent:x\n`)).toThrow();
		expect(() => parseTokens(`${sha("a")} human:x\n${sha("a")} human:y\n`)).toThrow();
	});
});

describe("hostile clients", () => {
	test("malformed JSON closes the socket", async () => {
		const c = await Client.open(server.port);
		c.sendRaw("{not json");
		expect((await c.next((f) => f.type === "error")).message).toBe("bad frame");
		expect(await c.waitClosed()).toBe(true);
	});

	test("a frame before auth closes the socket", async () => {
		const c = await Client.open(server.port);
		c.send({ type: "channel:list", id: "L" });
		expect((await c.next((f) => f.type === "error")).message).toBe("not authenticated");
		expect(await c.waitClosed()).toBe(true);
	});

	test("an oversized frame closes the socket", async () => {
		const c = await as(server.port, "local");
		c.send({ type: "message:post", id: "P", channelId: "x", content: "a".repeat(64 * 1024) });
		expect(await c.waitClosed()).toBe(true);
		// Bun drops the connection on an oversized frame; the client sees 1009 or an abnormal 1006.
		expect([1006, 1009]).toContain(c.closeCode);
	});

	test("content over 16 KB is refused and nothing is stored", async () => {
		const c = await as(server.port, "local");
		const general = (await channelIds(c))["ws-8gi--general"] as string;
		const before = ledgerEntries(dataDir).length;
		await expect(
			c.ask(
				{
					type: "message:post",
					id: "P",
					channelId: general,
					content: "é".repeat(MAX_CONTENT_BYTES / 2 + 1),
				},
				"message:posted",
			),
		).rejects.toMatchObject({ code: "TABLE_VALIDATION" });
		expect(ledgerEntries(dataDir).length).toBe(before);
		await c.ask(
			{ type: "message:post", id: "Q", channelId: general, content: "a".repeat(MAX_CONTENT_BYTES) },
			"message:posted",
		);
		c.close();
	});

	test("post flooding: a burst over the bucket is rate-limited", async () => {
		const c = await as(server.port, "local");
		const general = (await channelIds(c))["ws-8gi--general"] as string;
		for (let i = 0; i < 30; i++)
			c.send({ type: "message:post", id: `F${i}`, channelId: general, content: `flood ${i}` });
		let ok = 0;
		let limited = 0;
		for (let i = 0; i < 30; i++) {
			const f = await c.next(
				(x) => x.id === `F${i}` && (x.type === "message:posted" || x.type === "table:error"),
			);
			if (f.type === "message:posted") ok++;
			else if (f.code === "TABLE_RATE_LIMITED") limited++;
		}
		expect(ok).toBeGreaterThanOrEqual(POST_BURST);
		expect(ok).toBeLessThan(30);
		expect(ok + limited).toBe(30);
		c.close();
	});

	test("unit: the bucket refills at 10 a second up to the burst", () => {
		const s = { tokens: 0, refilledAt: 0 };
		expect(takePost(s, 0)).toBe(false);
		expect(takePost(s, 100)).toBe(true); // +1 after 100 ms
		expect(takePost(s, 100)).toBe(false);
		s.tokens = 0;
		s.refilledAt = 0;
		for (let i = 0; i < POST_BURST; i++) expect(takePost(s, 60_000)).toBe(true);
		expect(takePost(s, 60_000)).toBe(false);
	});
});

describe("connection limits (own server instance)", () => {
	let small: Running;
	beforeAll(async () => {
		const d = tempDir("table-server-limits-");
		fs.cpSync(fixtureDir, d, { recursive: true });
		const r = await startServer(d, tokensFile, [], {
			TABLE_MAX_CONNECTIONS: "4",
			TABLE_AUTH_TIMEOUT_MS: "300",
		});
		if (!("port" in r)) throw new Error(r.err);
		small = r;
	});
	afterAll(async () => {
		if (small) await stopServer(small);
	});

	test("an unauthenticated socket is closed after the auth timeout", async () => {
		const c = await Client.open(small.port);
		expect(await c.waitClosed(2000)).toBe(true);
		expect(c.closeCode).toBe(4408);
	});

	test("an authenticated socket outlives the auth timeout", async () => {
		const c = await Client.open(small.port);
		expect((await c.auth(T.local)).type).toBe("auth:ok");
		await new Promise((r) => setTimeout(r, 600));
		expect(c.closed).toBe(false);
		c.close();
	});

	test("connection flooding stops at the cap, and slots free up on close", async () => {
		await new Promise((r) => setTimeout(r, 200));
		const held: Client[] = [];
		for (let i = 0; i < 4; i++) {
			const c = await Client.open(small.port);
			await c.auth(T.local);
			held.push(c);
		}
		await expect(Client.open(small.port)).rejects.toThrow();
		held[0]?.close();
		await held[0]?.waitClosed();
		await new Promise((r) => setTimeout(r, 100));
		const again = await Client.open(small.port);
		expect((await again.auth(T.local)).type).toBe("auth:ok");
		for (const c of [...held, again]) c.close();
	});

	test("the default auth timeout is 5 s and the default cap is 64", async () => {
		const { DEFAULT_AUTH_TIMEOUT_MS, DEFAULT_MAX_CONNECTIONS } = await import("./server");
		expect(DEFAULT_AUTH_TIMEOUT_MS).toBe(5000);
		expect(DEFAULT_MAX_CONNECTIONS).toBe(64);
	});
});

describe("startup refusals", () => {
	const copy = () => {
		const d = tempDir("table-server-refuse-");
		fs.cpSync(fixtureDir, d, { recursive: true });
		return d;
	};

	test("no tokens file, a loose one, or a malformed one: exit 2", async () => {
		const d = copy();
		expect(await startServer(d, undefined)).toMatchObject({ exit: 2 });
		const loose = writeSecret(tempDir("table-server-loose-"), "tokens", tokensText(), 0o644);
		expect(await startServer(d, loose)).toMatchObject({ exit: 2 });
		const bad = writeSecret(
			tempDir("table-server-bad-"),
			"tokens",
			"plaintext-token human:local\n",
		);
		expect(await startServer(d, bad)).toMatchObject({ exit: 2 });
		const empty = writeSecret(tempDir("table-server-empty-"), "tokens", "# nothing\n");
		expect(await startServer(d, empty)).toMatchObject({ exit: 2 });
	});

	test("a symlinked tokens file is refused", async () => {
		const link = path.join(tempDir("table-server-link-"), "tokens");
		fs.symlinkSync(tokensFile, link);
		expect(await startServer(copy(), link)).toMatchObject({ exit: 2 });
	});

	test("a missing ledger key is an error unless --init-key is passed", async () => {
		const fresh = tempDir("table-server-fresh-");
		const refused = await startServer(fresh, tokensFile);
		expect(refused).toMatchObject({ exit: 2 });
		expect((refused as { err: string }).err).toContain("--init-key");
		expect(fs.existsSync(path.join(fresh, "keys", "state-hmac.key"))).toBe(false);
		const started = await startServer(fresh, tokensFile, ["--init-key"]);
		expect("port" in started).toBe(true);
		if ("port" in started) await stopServer(started);
		expect(fs.statSync(path.join(fresh, "keys", "state-hmac.key")).mode & 0o777).toBe(0o600);
	});

	test("TABLE_KEY_FILE: the key from a separate secret, off the data volume", async () => {
		const d = copy();
		fs.rmSync(path.join(d, "keys"), { recursive: true });
		const keyFile = writeSecret(tempDir("table-server-key-"), "ledger.key", key);
		const r = await startServer(d, tokensFile, [], { TABLE_KEY_FILE: keyFile });
		expect("port" in r).toBe(true);
		if ("port" in r) await stopServer(r);
		expect(fs.existsSync(path.join(d, "keys"))).toBe(false);
		const wrongSize = writeSecret(tempDir("table-server-key2-"), "ledger.key", randomBytes(16));
		expect(await startServer(d, tokensFile, [], { TABLE_KEY_FILE: wrongSize })).toMatchObject({
			exit: 2,
		});
		const wrongKey = writeSecret(tempDir("table-server-key3-"), "ledger.key", randomBytes(32));
		const r2 = await startServer(d, tokensFile, [], { TABLE_KEY_FILE: wrongKey });
		expect((r2 as { err: string }).err).toContain("ledger does not verify");
		const withInit = await startServer(d, tokensFile, ["--init-key"], { TABLE_KEY_FILE: keyFile });
		expect(withInit).toMatchObject({ exit: 2 });
	});

	test("a tampered ledger refuses to start", async () => {
		const d = copy();
		const file = path.join(d, "table", "ledger", "ledger.jsonl");
		const lines = fs.readFileSync(file, "utf8").trim().split("\n");
		const first = JSON.parse(lines[0] as string);
		first.payload = { ...first.payload, tampered: true };
		lines[0] = JSON.stringify(first);
		fs.writeFileSync(file, `${lines.join("\n")}\n`);
		const r = await startServer(d, tokensFile);
		expect(r).toMatchObject({ exit: 2 });
		expect((r as { err: string }).err).toContain("ledger does not verify");
	});
});

describe("the ledger after the server's mutations", () => {
	test("verifies, and grew by the posts and member adds made above", () => {
		const before = Ledger.open({ runId: "ledger", baseDir: path.join(fixtureDir, "table"), key });
		const base = before.verify();
		before.close();
		const after = Ledger.open({ runId: "ledger", baseDir: path.join(dataDir, "table"), key });
		const now = after.verify();
		after.close();
		expect(base.ok).toBe(true);
		expect(now.ok).toBe(true);
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
