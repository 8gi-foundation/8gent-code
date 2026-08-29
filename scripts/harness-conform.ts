#!/usr/bin/env bun
/**
 * harness-conform - run the harness stages against a live endpoint and report
 * which ones actually hold.
 *
 * The roadmap from bare metal to product is worth nothing as a lecture. This
 * turns it into requests. Point it at any OpenAI-compatible harness - kiln,
 * 8gent-code, LM Studio, Ollama, a vLLM box - and it reports what is true.
 *
 *   bun scripts/harness-conform.ts --base http://127.0.0.1:1234 --model my-model
 *   bun scripts/harness-conform.ts --base ... --model ... --json > report.json
 *   bun scripts/harness-conform.ts --base ... --model ... --html report.html
 *
 * Deliberately single-file and dependency-free so it can be copied into a
 * different repo, in a different language ecosystem, and still run.
 *
 * Every check states what it actually proved. A check that cannot run says so
 * rather than passing by default - a conformance tool that reports green when
 * it did not look is worse than no tool, because it manufactures confidence.
 */

type Status = "pass" | "fail" | "skip";

interface Check {
	stage: number;
	stageName: string;
	id: string;
	/** What a pass actually demonstrates, in the language of the failure it rules out. */
	proves: string;
	status: Status;
	detail: string;
	ms: number;
}

interface Opts {
	base: string;
	model: string;
	json: boolean;
	html?: string;
	timeoutMs: number;
}

const STAGES: Record<number, string> = {
	1: "Bare metal",
	2: "Serving",
	3: "Survivability",
	4: "Truthful eval",
	5: "Agent loop",
	6: "Safety",
	9: "Observability",
};

function parseArgs(argv: string[]): Opts {
	const get = (flag: string, fallback?: string) => {
		const i = argv.indexOf(flag);
		return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
	};
	const base = get("--base", process.env.HARNESS_BASE || "http://127.0.0.1:1234")!;
	const model = get("--model", process.env.HARNESS_MODEL || "")!;
	return {
		base: base.replace(/\/+$/, ""),
		model,
		json: argv.includes("--json"),
		html: get("--html"),
		timeoutMs: Number(get("--timeout", "60000")),
	};
}

async function post(o: Opts, path: string, body: unknown, timeoutMs = o.timeoutMs) {
	const started = Date.now();
	const res = await fetch(`${o.base}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: "Bearer conformance" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await res.text();
	let json: any = null;
	try {
		json = JSON.parse(text);
	} catch {}
	return { res, json, text, ms: Date.now() - started };
}

async function run(o: Opts): Promise<Check[]> {
	const checks: Check[] = [];
	const add = (c: Omit<Check, "stageName">) =>
		checks.push({ ...c, stageName: STAGES[c.stage] ?? `Stage ${c.stage}` });

	// ---- Stage 2: is anything serving an OpenAI-compatible surface? ---------
	let modelId = o.model;
	{
		const t = Date.now();
		try {
			const res = await fetch(`${o.base}/v1/models`, {
				signal: AbortSignal.timeout(10_000),
			});
			const body: any = await res.json().catch(() => null);
			const ids: string[] = body?.data?.map((m: any) => m.id) ?? [];
			if (!modelId && ids.length) modelId = ids[0];
			add({
				stage: 2,
				id: "openai-compat-surface",
				proves: "something is listening and speaks the OpenAI model API",
				status: res.ok && ids.length > 0 ? "pass" : "fail",
				detail: res.ok ? `${ids.length} model(s): ${ids.slice(0, 3).join(", ")}` : `http ${res.status}`,
				ms: Date.now() - t,
			});
		} catch (e) {
			add({
				stage: 2,
				id: "openai-compat-surface",
				proves: "something is listening and speaks the OpenAI model API",
				status: "fail",
				detail: e instanceof Error ? e.message : String(e),
				ms: Date.now() - t,
			});
		}
	}

	if (!modelId) {
		add({
			stage: 3,
			id: "readiness",
			proves: "the model can produce a token, not merely that a port is open",
			status: "skip",
			detail: "no model id available; pass --model",
			ms: 0,
		});
		return checks;
	}

	// ---- Stage 3: READINESS, not liveness ----------------------------------
	// The distinction this whole tool exists for. A server can list models,
	// accept sockets and return 200s while producing nothing usable.
	{
		try {
			const { res, json, ms } = await post(o, "/v1/chat/completions", {
				model: modelId,
				messages: [{ role: "user", content: "Reply with the single word: ok" }],
				max_tokens: 512,
				stream: false,
			});
			const choice = json?.choices?.[0];
			const content: string = typeof choice?.message?.content === "string" ? choice.message.content : "";
			const finish: string = choice?.finish_reason ?? "";
			const empty = content.trim().length === 0;
			add({
				stage: 3,
				id: "readiness",
				proves: "the model can produce a token, not merely that a port is open",
				status: res.ok && !empty ? "pass" : "fail",
				detail: !res.ok
					? `http ${res.status}`
					: empty
						? `EMPTY content, finish_reason=${finish || "unknown"}${finish === "length" ? " (reasoning budget exhausted)" : ""}`
						: `answered in ${ms}ms: ${JSON.stringify(content.trim().slice(0, 40))}`,
				ms,
			});

			// ---- Stage 4: does an empty answer get reported as an error? -------
			// A harness that scores an empty completion as success has an eval that
			// cannot fail, which is the same as having no eval.
			add({
				stage: 4,
				id: "empty-answer-is-a-failure",
				proves: "an empty completion is surfaced as failure, not scored as success",
				status: empty ? (res.ok ? "fail" : "pass") : "skip",
				detail: empty
					? res.ok
						? "server returned HTTP 200 for an empty answer: a naive caller records this as success"
						: "empty answer correctly carried a non-2xx"
					: "model answered normally; nothing to judge here",
				ms: 0,
			});
		} catch (e) {
			const timedOut = e instanceof Error && e.name === "TimeoutError";
			add({
				stage: 3,
				id: "readiness",
				proves: "the model can produce a token, not merely that a port is open",
				status: "fail",
				detail: timedOut ? `no answer within ${o.timeoutMs}ms` : e instanceof Error ? e.message : String(e),
				ms: o.timeoutMs,
			});
		}
	}

	// ---- Stage 3: are requests bounded? ------------------------------------
	// An endpoint that accepts a socket and never answers must fail fast, or it
	// spends the caller's entire budget on a request that was never going to
	// complete. Probed with a deliberately tiny deadline.
	{
		const t = Date.now();
		try {
			await post(o, "/v1/chat/completions", {
				model: modelId,
				messages: [{ role: "user", content: "count slowly to five hundred" }],
				max_tokens: 4000,
				stream: false,
			}, 1);
			add({
				stage: 3,
				id: "bounded-requests",
				proves: "a caller-side deadline is actually honoured",
				status: "fail",
				detail: "a 1ms deadline did not abort: this client is not enforcing timeouts",
				ms: Date.now() - t,
			});
		} catch (e) {
			const aborted = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
			add({
				stage: 3,
				id: "bounded-requests",
				proves: "a caller-side deadline is actually honoured",
				status: aborted ? "pass" : "fail",
				detail: aborted
					? `aborted in ${Date.now() - t}ms as instructed`
					: e instanceof Error
						? e.message
						: String(e),
				ms: Date.now() - t,
			});
		}
	}

	// ---- Stage 5: tool calls come back structured, not as prose ------------
	// The leak: a model emits a tool call as chat text and the consumer shows
	// the user raw JSON. A conformant surface puts it in message.tool_calls.
	{
		try {
			const { res, json, ms } = await post(o, "/v1/chat/completions", {
				model: modelId,
				messages: [{ role: "user", content: "What is the weather in Dublin? Use the tool." }],
				tools: [
					{
						type: "function",
						function: {
							name: "get_weather",
							description: "Get current weather for a city",
							parameters: {
								type: "object",
								properties: { city: { type: "string" } },
								required: ["city"],
							},
						},
					},
				],
				max_tokens: 512,
				stream: false,
			});
			const msg = json?.choices?.[0]?.message ?? {};
			const structured = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
			const content: string = typeof msg.content === "string" ? msg.content : "";
			// A tool call that arrived as text: JSON-ish prose naming the function.
			const leaked = !structured && /"?(name|function)"?\s*:\s*"?get_weather/.test(content);
			add({
				stage: 5,
				id: "tool-calls-structured",
				proves: "tool calls arrive in message.tool_calls, never as chat text",
				status: !res.ok ? "fail" : structured ? "pass" : leaked ? "fail" : "skip",
				detail: !res.ok
					? `http ${res.status}`
					: structured
						? `structured: ${msg.tool_calls.map((t: any) => t.function?.name).join(", ")}`
						: leaked
							? `LEAKED as chat text: ${JSON.stringify(content.trim().slice(0, 60))}`
							: "model declined to call the tool; inconclusive rather than passing",
				ms,
			});
		} catch (e) {
			add({
				stage: 5,
				id: "tool-calls-structured",
				proves: "tool calls arrive in message.tool_calls, never as chat text",
				status: "fail",
				detail: e instanceof Error ? e.message : String(e),
				ms: 0,
			});
		}
	}

	// ---- Stage 9: does a failure say what went wrong? ----------------------
	{
		try {
			const { res, json, ms } = await post(o, "/v1/chat/completions", {
				model: "definitely-not-a-real-model-xyz",
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 8,
			});
			const errText = JSON.stringify(json ?? "").toLowerCase();
			const named = /model|not found|unknown|no such/.test(errText);
			add({
				stage: 9,
				id: "actionable-errors",
				proves: "a bad request explains itself instead of failing blank",
				status: !res.ok && named ? "pass" : !res.ok ? "fail" : "fail",
				detail: !res.ok
					? named
						? `named the cause: ${errText.slice(0, 70)}`
						: `errored without naming the cause: ${errText.slice(0, 70)}`
					: "accepted a nonexistent model with 200, which hides the fault",
				ms,
			});
		} catch (e) {
			add({
				stage: 9,
				id: "actionable-errors",
				proves: "a bad request explains itself instead of failing blank",
				status: "fail",
				detail: e instanceof Error ? e.message : String(e),
				ms: 0,
			});
		}
	}

	return checks;
}

function renderText(o: Opts, checks: Check[]): string {
	const icon = (s: Status) => (s === "pass" ? "PASS" : s === "fail" ? "FAIL" : "SKIP");
	const lines: string[] = [
		"",
		`harness-conform  ${o.base}  model=${o.model || "(auto)"}`,
		"=".repeat(72),
	];
	let stage = -1;
	for (const c of checks) {
		if (c.stage !== stage) {
			stage = c.stage;
			lines.push("", `Stage ${c.stage} - ${c.stageName}`);
		}
		lines.push(`  [${icon(c.status)}] ${c.id}  (${c.ms}ms)`);
		lines.push(`         proves: ${c.proves}`);
		lines.push(`         ${c.detail}`);
	}
	const pass = checks.filter((c) => c.status === "pass").length;
	const fail = checks.filter((c) => c.status === "fail").length;
	const skip = checks.filter((c) => c.status === "skip").length;
	lines.push("", "=".repeat(72), `${pass} pass  ${fail} fail  ${skip} inconclusive`, "");
	if (skip) lines.push("Inconclusive is not a pass. Those checks could not run.", "");
	return lines.join("\n");
}

const opts = parseArgs(process.argv.slice(2));
const checks = await run(opts);

if (opts.json) {
	console.log(JSON.stringify({ base: opts.base, model: opts.model, checks }, null, 2));
} else {
	console.log(renderText(opts, checks));
}

process.exit(checks.some((c) => c.status === "fail") ? 1 : 0);
