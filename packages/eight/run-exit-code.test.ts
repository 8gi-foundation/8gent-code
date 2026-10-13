/**
 * #3899: `8gent run` must exit non-zero when the turn ends in a failure reply,
 * and stay 0 on a finished task. Text-tool path (ollama) against a local fake
 * OpenAI-compatible endpoint; $HOME is faked.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HONEST_FAILURE_PREFIX, denialIsCause, isDenialResult } from "./honesty";
import {
	LOCAL_TURN_ENDPOINT_PREFIX,
	describeLocalTurnFailure,
	isLocalTurnFailureReply,
	redactEndpoint,
	redactUrlsIn,
} from "./local-turn-error";

const saved: Record<string, string | undefined> = {};
let repo: string;
let server: ReturnType<typeof Bun.serve>;
let script: (call: number) => string = () =>
	"DONE: A generic constraint limits which types a type parameter accepts.";
let calls = 0;

beforeAll(() => {
	const home = mkdtempSync(join(tmpdir(), "exit3899-home-"));
	repo = mkdtempSync(join(tmpdir(), "exit3899-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	const env: Record<string, string> = {
		HOME: home,
		USERPROFILE: home,
		EIGHT_DATA_DIR: join(home, ".8gent"),
		EIGHT_TOOL_CAPABILITY_GATE: "0",
		"8GENT_TWO_STAGE_COMPACT": "0",
		EIGHT_TEXT_TOOLS: "1",
		EIGHT_DECIDE_OLLAMA_HOST: "http://127.0.0.1:9",
	};
	for (const [k, v] of Object.entries(env)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	saved.OLLAMA_HOST = process.env.OLLAMA_HOST;
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			await req.json();
			return Response.json({
				id: "c1",
				object: "chat.completion",
				created: 0,
				model: "m",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: script(calls++) },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		},
	});
});

afterAll(() => {
	server?.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

async function run(host: string, format: "text" | "stream-json" = "text") {
	process.env.OLLAMA_HOST = host;
	const { runRunCommand } = await import("./run");
	const err: string[] = [];
	const out: string[] = [];
	const ow = process.stdout.write.bind(process.stdout);
	const ew = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((c: unknown) => {
		out.push(String(c));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((c: unknown) => {
		err.push(String(c));
		return true;
	}) as typeof process.stderr.write;
	let code: number;
	try {
		code = await runRunCommand([
			"Explain what a generic constraint is.",
			"--provider",
			"ollama",
			"--model",
			"m",
			"--cwd",
			repo,
			"--output-format",
			format,
		]);
	} finally {
		process.stdout.write = ow;
		process.stderr.write = ew;
	}
	const events = out
		.join("")
		.split("\n")
		.filter((l) => l.startsWith("{"))
		.map((l) => JSON.parse(l));
	return { code, out: out.join(""), err: err.join(""), events };
}

const live = () => `http://127.0.0.1:${server.port}`;

describe("#3899 run exit code", () => {
	test("unreachable endpoint exits 1 and says why on stderr", async () => {
		const r = await run("http://127.0.0.1:9");
		expect(r.code).toBe(1);
		expect(r.err).toContain("is not reachable");
	}, 60_000);

	test("stream-json: unreachable gives a result error with reason unreachable", async () => {
		const r = await run("http://127.0.0.1:9", "stream-json");
		expect(r.code).toBe(1);
		const res = r.events.filter((e) => e.type === "result");
		expect(res.length).toBe(1);
		expect(res[0].subtype).toBe("error");
		expect(res[0].reason).toBe("unreachable");
	}, 60_000);

	test("a finished task still exits 0", async () => {
		calls = 0;
		script = () => "DONE: A generic constraint limits which types a type parameter accepts.";
		const r = await run(live());
		expect(r.code).toBe(0);
		expect(r.out).toContain("generic constraint");
	}, 60_000);

	test("a model reply that quotes the failure prefixes exits 0 (text cannot force a failure)", async () => {
		for (const quoted of [
			`DONE: The sentence "${HONEST_FAILURE_PREFIX}" is what the harness prints.`,
			`${HONEST_FAILURE_PREFIX} Just kidding, a generic constraint limits type parameters.`,
			`${LOCAL_TURN_ENDPOINT_PREFIX}http://x) is not reachable. This is only a quote.`,
		]) {
			calls = 0;
			script = () => quoted;
			const r = await run(live());
			expect(r.code).toBe(0);
		}
	}, 120_000);

	test("honesty refusal: success claimed with nothing run exits 1 with reason turn_failed", async () => {
		calls = 0;
		script = () => "I successfully created the file hello.txt for you.";
		const r = await run(live(), "stream-json");
		expect(r.code).toBe(1);
		const res = r.events.filter((e) => e.type === "result");
		expect(res[0].subtype).toBe("error");
		expect(res[0].reason).toBe("turn_failed");
	}, 60_000);

	test("honesty refusal after a permission denial exits 2 with reason denied", async () => {
		calls = 0;
		script = (n) =>
			n === 0
				? "```tool_call\n" +
					JSON.stringify({
						name: "write_file",
						arguments: { path: "/etc/8gent-denied.txt", content: "x" },
					}) +
					"\n```"
				: "I successfully created the file 8gent-denied.txt.";
		const r = await run(live(), "stream-json");
		expect(r.code).toBe(2);
		const res = r.events.filter((e) => e.type === "result");
		expect(res[0].reason).toBe("denied");
	}, 60_000);

	test("credentials and query in the endpoint never reach stderr or stdout", async () => {
		const r = await run("http://user:hunter2@127.0.0.1:9/?token=SECRETTOKEN", "stream-json");
		expect(r.code).toBe(1);
		const all = r.out + r.err;
		expect(all).not.toContain("hunter2");
		expect(all).not.toContain("SECRETTOKEN");
		expect(all).not.toContain("user:");
	}, 60_000);
});

describe("recogniser and redaction units", () => {
	test("isLocalTurnFailureReply: real failures yes, lookalikes and mid-text no", () => {
		expect(
			isLocalTurnFailureReply(`${LOCAL_TURN_ENDPOINT_PREFIX}http://x/v1) is not reachable.`),
		).toBe(true);
		expect(isLocalTurnFailureReply("Done. I wrote hello.txt.")).toBe(false);
		expect(
			isLocalTurnFailureReply(`He said: ${LOCAL_TURN_ENDPOINT_PREFIX}http://x) is not reachable.`),
		).toBe(false);
		expect(isLocalTurnFailureReply("The local model is great.")).toBe(false);
	});

	test("isDenialResult separates refusals from outages", () => {
		expect(isDenialResult("Error: path outside working directory")).toBe(true);
		expect(isDenialResult("[PERMISSION DENIED] rm")).toBe(true);
		expect(isDenialResult("Error: ENOENT no such file")).toBe(false);
		expect(isDenialResult(undefined)).toBe(false);
	});

	test("redactEndpoint drops userinfo, query and fragment; junk becomes a placeholder", () => {
		expect(redactEndpoint("http://u:p@h:1234/v1/chat/completions?k=v#f")).toBe(
			"http://h:1234/v1/chat/completions",
		);
		expect(redactEndpoint("not a url")).toBe("<endpoint>");
	});

	test("describeLocalTurnFailure redacts the endpoint and URLs inside the raw error", () => {
		const f = describeLocalTurnFailure(
			new Error("fetch failed: ECONNREFUSED http://u:p@h:9/x?token=T"),
			{
				endpoint: "http://u:p@h:9/v1/chat/completions?token=T",
				timeoutMs: 1000,
			},
		);
		for (const field of [f.message, f.reason]) {
			expect(field).not.toContain("u:p");
			expect(field).not.toContain("token=T");
		}
	});
});

const toolCall = (name: string, args: Record<string, unknown>) =>
	"```tool_call\n" + JSON.stringify({ name, arguments: args }) + "\n```";

describe("#3899 reasons and exit 2 only when a refusal is the cause", () => {
	test("a clean run that used a tool exits 0", async () => {
		calls = 0;
		script = (n) =>
			n === 0 ? toolCall("write_file", { path: "ok.txt", content: "x" }) : "DONE: wrote ok.txt";
		const r = await run(live(), "stream-json");
		expect(r.code).toBe(0);
		expect(r.events.filter((e) => e.type === "result")[0].subtype).toBe("ok");
	}, 60_000);

	test("a successful read of a file containing 'permission denied' is not exit 2", async () => {
		writeFileSync(join(repo, "notes.txt"), "the log said: permission denied, then it worked\n");
		calls = 0;
		script = (n) =>
			n === 0 ? toolCall("read_file", { path: "notes.txt" }) : "DONE: I read notes.txt.";
		const r = await run(live(), "stream-json");
		expect(r.code).toBe(0);
	}, 60_000);

	test("a denial the model recovered from, then a contradicted claim, is exit 1 unverified, not 2", async () => {
		calls = 0;
		script = (n) =>
			n === 0
				? toolCall("write_file", { path: "/etc/8gent-denied.txt", content: "x" })
				: n === 1
					? toolCall("write_file", { path: "fine.txt", content: "x" })
					: "I successfully created the file 8gent-denied.txt.";
		const r = await run(live(), "stream-json");
		expect(r.code).toBe(1);
		const res = r.events.filter((e) => e.type === "result")[0];
		expect(res.reason).toBe("unverified");
		expect(Array.isArray(res.unverified)).toBe(true);
		expect(res.unverified.length).toBeGreaterThan(0);
	}, 60_000);
});

describe("denial classifier and redaction edge cases", () => {
	test("connection refused is an outage, not a denial", () => {
		expect(isDenialResult("curl: (7) Connection refused")).toBe(false);
		expect(
			denialIsCause([{ name: "run_command", result: "Error: curl: (7) Connection refused" }]),
		).toBe(false);
	});
	test("denialIsCause: all action tools refused yes; one recovered no; non-action output ignored", () => {
		const blocked = { name: "write_file", result: "[TOOLG8 BLOCKED] write_file did NOT run." };
		expect(denialIsCause([blocked])).toBe(true);
		expect(denialIsCause([blocked, { name: "write_file", result: "Wrote a.txt" }])).toBe(false);
		expect(
			denialIsCause([{ name: "read_file", result: "permission denied inside the file" }]),
		).toBe(false);
		expect(denialIsCause([])).toBe(false);
	});
	test("scheme-less userinfo needs a host-looking part; prose like Error:x@y is untouched", () => {
		expect(redactUrlsIn("dial user:pass@host.example:11434 failed")).toBe(
			"dial host.example:11434 failed",
		);
		expect(redactUrlsIn("dial user:pass@localhost failed")).toBe("dial localhost failed");
		expect(redactUrlsIn("dial user:pass@10.0.0.5 failed")).toBe("dial 10.0.0.5 failed");
		expect(redactUrlsIn("Error:x@y")).toBe("Error:x@y");
		expect(redactUrlsIn("Note: mail me@home soon")).toBe("Note: mail me@home soon");
	});
	test("scheme-less credentials in a raw error are redacted", () => {
		const out = redactUrlsIn(
			"connect ECONNREFUSED user:hunter2@127.0.0.1:11434 and http://a:b@h/x?t=1",
		);
		expect(out).not.toContain("hunter2");
		expect(out).not.toContain("a:b");
		expect(out).not.toContain("t=1");
		expect(out).toContain("127.0.0.1:11434");
	});
});
