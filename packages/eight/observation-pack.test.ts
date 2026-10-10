import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ObservationPacker,
	ObservationStore,
	observationPackEnabled,
	readOutputTool,
} from "./observation-pack";

type Msg = { role: "system" | "user" | "assistant" | "tool"; content: string };

const dirs: string[] = [];
function freshDir(): string {
	const d = mkdtempSync(join(tmpdir(), "obs-pack-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A 40 KB fake tool result with multi-byte characters and CRLF, so a lossy
// round trip (encoding, line endings, trimming) cannot pass.
function bigLog(seed: string): string {
	const lines: string[] = [];
	for (let i = 0; i < 800; i++) lines.push(`${seed} line ${i} ok é中\r`);
	return `Tool run_command returned:\n${lines.join("\n")}\nFAIL at the end ${seed}`;
}
const result = (body: string): Msg => ({ role: "user", content: body });

function filesUnder(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else out.push(p);
		}
	};
	walk(dir);
	return out;
}

describe("observationPackEnabled", () => {
	test("on only for exactly 1", () => {
		expect(observationPackEnabled({})).toBe(false);
		expect(observationPackEnabled({ EIGHT_OBSERVATION_PACK: "0" })).toBe(false);
		expect(observationPackEnabled({ EIGHT_OBSERVATION_PACK: "true" })).toBe(false);
		expect(observationPackEnabled({ EIGHT_OBSERVATION_PACK: "1" })).toBe(true);
	});
});

describe("ObservationPacker", () => {
	test("a big result stays whole for two requests, then becomes a handle", () => {
		const dir = freshDir();
		const store = new ObservationStore(join(dir, "session-a"));
		const packer = new ObservationPacker(store);
		const log = bigLog("A");
		const base: Msg[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "run the tests" },
			{ role: "assistant", content: "running" },
			result(log),
		];
		// Request 1 and 2: whole.
		expect(packer.pack(base)[3].content).toBe(log);
		const r2 = [
			...base,
			{ role: "assistant" as const, content: "next" },
			result("Tool x returned:\nsmall"),
		];
		expect(packer.pack(r2)[3].content).toBe(log);
		// Request 3: packed.
		const r3 = [
			...r2,
			{ role: "assistant" as const, content: "more" },
			result("Tool y returned:\nsmall"),
		];
		const out = packer.pack(r3);
		const stub = out[3].content;
		expect(stub).not.toBe(log);
		expect(stub.length).toBeLessThan(1500);
		expect(stub).toContain(`${log.length} chars`);
		expect(stub).toContain("read_output");
		// Head and tail excerpt: the failure at the end is still visible.
		expect(stub).toContain("FAIL at the end A");
		expect(stub).toContain("Tool run_command returned:");
		// Input never mutated.
		expect(r3[3].content).toBe(log);
	});

	test("the handle round-trips to the exact original bytes", async () => {
		const dir = freshDir();
		const store = new ObservationStore(join(dir, "session-a"));
		const packer = new ObservationPacker(store, { window: 0 });
		const log = bigLog("B");
		const stub = packer.pack([result(log)])[0].content;
		const handle = /handle ([0-9a-f-]{36})/.exec(stub)?.[1] ?? "";
		expect(handle).not.toBe("");
		expect(store.read(handle)).toBe(log);
		expect(Buffer.from(store.read(handle), "utf8").equals(Buffer.from(log, "utf8"))).toBe(true);
		// Ranged reads through the tool concatenate back to the original.
		const tool = readOutputTool(store);
		let joined = "";
		for (let off = 0; off < log.length; off += 5000) {
			const part = await tool.run({ handle, offset: off, limit: 5000 });
			joined += part.slice(part.indexOf("\n") + 1);
		}
		expect(joined).toBe(log);
	});

	test("spill files are 0600 under the session's own dir", () => {
		const dir = freshDir();
		const sessionDir = join(dir, "sessions", "session_123");
		const store = new ObservationStore(sessionDir);
		new ObservationPacker(store, { window: 0 }).pack([result(bigLog("C"))]);
		const files = filesUnder(dir);
		expect(files.length).toBe(1);
		expect(files[0].startsWith(sessionDir)).toBe(true);
		expect(statSync(files[0]).mode & 0o777).toBe(0o600);
	});

	test("recent outputs, small outputs and non-result messages are untouched", () => {
		const dir = freshDir();
		const packer = new ObservationPacker(new ObservationStore(dir));
		const bigUser = `please read this ${"x".repeat(20_000)}`; // a big user prompt, not a tool result
		const small = "Tool read_file returned:\nshort";
		const msgs: Msg[] = [
			result(bigUser),
			result(small),
			{ role: "assistant", content: "y".repeat(20_000) },
		];
		for (let i = 0; i < 5; i++) packer.pack(msgs);
		const out = packer.pack(msgs);
		expect(out).toEqual(msgs);
		expect(filesUnder(dir).length).toBe(0);
		// A big result that has only just arrived is whole.
		const fresh = [...msgs, result(bigLog("D"))];
		expect(packer.pack(fresh)[3].content).toBe(fresh[3].content);
	});

	test("the prompt prefix is byte-stable between consecutive calls, no re-packing churn", () => {
		const dir = freshDir();
		const packer = new ObservationPacker(new ObservationStore(dir));
		let msgs: Msg[] = [{ role: "system", content: "sys" }, result(bigLog("E"))];
		let prev: Msg[] = packer.pack(msgs);
		for (let i = 0; i < 8; i++) {
			msgs = [
				...msgs,
				{ role: "assistant", content: `step ${i}` },
				result(`Tool t returned:\n${i}`),
			];
			const next = packer.pack(msgs);
			// Request 3 is the one packing step; every other consecutive pair
			// shares the whole previous request as an exact prefix.
			if (i !== 1) {
				expect(JSON.stringify(next.slice(0, prev.length))).toBe(JSON.stringify(prev));
			}
			prev = next;
		}
		// One result, one file, however many calls.
		expect(filesUnder(dir).length).toBe(1);
	});

	test("an unknown handle is refused, never a path", async () => {
		const dir = freshDir();
		const tool = readOutputTool(new ObservationStore(dir));
		const out = await tool.run({ handle: "../../etc/passwd" });
		expect(out.startsWith("Error")).toBe(true);
	});

	test("a store that cannot write leaves the result whole", () => {
		const dir = freshDir();
		// A file where the store's directory should be: mkdir fails.
		const blocker = join(dir, "blocked");
		writeFileSync(blocker, "x");
		const packer = new ObservationPacker(new ObservationStore(blocker), { window: 0 });
		const log = bigLog("F");
		expect(packer.pack([result(log)])[0].content).toBe(log);
	});
});

// Wiring: chat() on the text-tool path against a fake local endpoint, $HOME
// faked. A 40 KB read_file result is whole in requests 2 and 3, a handle from
// request 4, and read_output returns its exact bytes.
describe("Agent text-tool path with EIGHT_OBSERVATION_PACK", () => {
	type Body = { messages: Array<{ role: string; content: unknown }> };
	const keys = [
		"HOME",
		"EIGHT_HOME",
		"EIGHT_DATA_DIR",
		"EIGHT_TOOL_CAPABILITY_GATE",
		"8GENT_TWO_STAGE_COMPACT",
		"EIGHT_TEXT_TOOLS",
		"OLLAMA_HOST",
		"EIGHT_OBSERVATION_PACK",
	];
	const saved: Record<string, string | undefined> = {};
	let home = "";
	let repo = "";
	let server: ReturnType<typeof Bun.serve>;
	let bodies: Body[] = [];
	let Agent: typeof import("./agent").Agent;
	const big = Array.from({ length: 900 }, (_, i) => `log line ${i} é status ok`).join("\n");

	const reply = (content: string) =>
		Response.json({
			id: "c",
			object: "chat.completion",
			created: 0,
			model: "m",
			choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		});
	const toolCall = (name: string, args: Record<string, unknown>) =>
		reply(["```tool_call", JSON.stringify({ name, arguments: args }), "```"].join("\n"));
	const text = (b: Body) =>
		b.messages
			.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
			.join("\n");

	beforeAll(async () => {
		home = mkdtempSync(join(tmpdir(), "obs-pack-home-"));
		repo = mkdtempSync(join(tmpdir(), "obs-pack-repo-"));
		mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
		writeFileSync(join(repo, "big.txt"), big);
		for (const k of keys) saved[k] = process.env[k];
		Object.assign(process.env, {
			HOME: home,
			EIGHT_HOME: home,
			EIGHT_DATA_DIR: join(home, ".8gent"),
			EIGHT_TOOL_CAPABILITY_GATE: "0",
			"8GENT_TWO_STAGE_COMPACT": "0",
			EIGHT_TEXT_TOOLS: "1",
		});
		({ Agent } = await import("./agent"));
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method !== "POST") return Response.json({ models: [], data: [] });
				const body = (await req.json()) as Body;
				bodies.push(body);
				const n = bodies.length;
				if (n === 1) return toolCall("read_file", { path: join(repo, "big.txt") });
				if (n === 2 || n === 3) return toolCall("list_files", { path: repo });
				const handle = /handle ([0-9a-f-]{36})/.exec(text(body))?.[1];
				if (n === 4 && handle) return toolCall("read_output", { handle, offset: 0, limit: 8000 });
				return reply("DONE: read the log.");
			},
		});
		process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
	});
	afterEach(() => {
		bodies = [];
		Reflect.deleteProperty(process.env, "EIGHT_OBSERVATION_PACK");
	});
	afterAll(() => {
		server?.stop(true);
		rmSync(home, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
		for (const k of keys) {
			if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
			else process.env[k] = saved[k];
		}
	});

	const build = () =>
		new Agent({
			model: "m",
			runtime: "ollama",
			workingDirectory: repo,
			baseUrl: `http://127.0.0.1:${server.port}`,
		} as ConstructorParameters<typeof Agent>[0]);

	test("flag on: packed from request 4, read back exactly", async () => {
		process.env.EIGHT_OBSERVATION_PACK = "1";
		await build().chat("Read big.txt and tell me what it says.");
		expect(bodies.length).toBeGreaterThanOrEqual(5);
		expect(text(bodies[0])).toContain("read_output(");
		const tail = "log line 899";
		expect(text(bodies[1])).toContain(tail);
		expect(text(bodies[2])).toContain(tail);
		expect(text(bodies[3])).not.toContain("log line 450 ");
		const r4 = text(bodies[3]);
		expect(r4).toContain("Earlier tool output packed");
		expect(r4.length).toBeLessThan(text(bodies[2]).length);
		// read_output's result carries the first 8000 chars of the saved output, exactly.
		const handle = /handle ([0-9a-f-]{36})/.exec(r4)?.[1] ?? "";
		const saved =
			filesUnder(join(home, ".8gent", "sessions")).find((f) => f.endsWith(`${handle}.txt`)) ?? "";
		expect(saved).not.toBe("");
		expect(statSync(saved).mode & 0o777).toBe(0o600);
		const full = readFileSync(saved, "utf8");
		expect(full).toContain("log line 0 \u00e9 status ok");
		expect(full).toContain("log line 899 \u00e9 status ok");
		expect(text(bodies[4])).toContain(full.slice(0, 8000));
	}, 60_000);

	test("flag off (default): nothing packed, no read_output tool", async () => {
		await build().chat("Read big.txt and tell me what it says.");
		for (const b of bodies) expect(text(b)).not.toContain("Earlier tool output packed");
		expect(text(bodies[bodies.length - 1])).toContain("log line 450 ");
		expect(text(bodies[0])).not.toContain("read_output");
	}, 60_000);
});
