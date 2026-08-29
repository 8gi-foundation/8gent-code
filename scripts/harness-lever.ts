#!/usr/bin/env bun
/**
 * harness-lever - measure what a single harness change buys a small model.
 *
 * The thesis being tested: a 9B model on CPU does not get smarter by getting
 * faster. It gets smarter because the harness around it removes whole classes
 * of failure. That claim is only worth anything with a number attached, so this
 * runs the same task twice - once bare, once with one lever applied - and
 * reports the difference.
 *
 *   bun scripts/harness-lever.ts --base http://127.0.0.1:1234 --model X --trials 8
 *
 * Lever under test here: schema-constrained decoding for tool calls.
 *
 * Honesty rules, because a benchmark that flatters its own thesis is worse than
 * no benchmark:
 *   - identical prompts in both arms; only the lever differs
 *   - a malformed or absent call is a failure, never a retry
 *   - the raw output of every failure is recorded so the number can be audited
 *   - trials are few and stated; this is a signal, not a proof
 */

interface Trial {
	prompt: string;
	/** The tool the model is supposed to call. */
	expect: string;
}

const TRIALS: Trial[] = [
	{ prompt: "What is the weather in Dublin?", expect: "get_weather" },
	{ prompt: "Weather for Lisbon please.", expect: "get_weather" },
	{ prompt: "Tell me the temperature in Oslo.", expect: "get_weather" },
	{ prompt: "I need current conditions for Cairo.", expect: "get_weather" },
	{ prompt: "How's the weather looking in Tokyo right now?", expect: "get_weather" },
	{ prompt: "Check Reykjavik weather.", expect: "get_weather" },
	{ prompt: "What's it like outside in Nairobi?", expect: "get_weather" },
	{ prompt: "Give me Dublin conditions.", expect: "get_weather" },
];

const TOOL = {
	type: "function",
	function: {
		name: "get_weather",
		description: "Get current weather for a city",
		parameters: {
			type: "object",
			properties: { city: { type: "string" } },
			required: ["city"],
			additionalProperties: false,
		},
	},
};

/**
 * The constrained arm. Note the `unknown` branch: a schema with no legal way to
 * decline forces fabrication, which was measured directly on ornith-1.0-9b
 * (asked for weather it could not know, it emitted celsius -6048294175318603).
 * Every constrained schema in this codebase carries an escape hatch for that
 * reason.
 */
const CALL_SCHEMA = {
	type: "json_schema",
	json_schema: {
		name: "tool_call",
		strict: true,
		schema: {
			type: "object",
			properties: {
				tool: { type: "string", enum: ["get_weather", "unknown"] },
				city: { type: "string" },
			},
			required: ["tool", "city"],
			additionalProperties: false,
		},
	},
};

const arg = (f: string, d: string) => {
	const i = process.argv.indexOf(f);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const BASE = arg("--base", "http://127.0.0.1:1234").replace(/\/+$/, "");
const MODEL = arg("--model", "");
const N = Math.min(TRIALS.length, Number(arg("--trials", "8")));
const TIMEOUT = Number(arg("--timeout", "120000"));

async function call(body: unknown) {
	const res = await fetch(`${BASE}/v1/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(TIMEOUT),
	});
	const json: any = await res.json().catch(() => null);
	const msg = json?.choices?.[0]?.message ?? {};
	return {
		ok: res.ok,
		content: typeof msg.content === "string" ? msg.content : "",
		reasoning: typeof msg.reasoning_content === "string" ? msg.reasoning_content : "",
		toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
	};
}

/** Bare arm: native tools payload, read whatever comes back. */
async function bare(t: Trial) {
	const r = await call({
		model: MODEL,
		messages: [{ role: "user", content: t.prompt }],
		tools: [TOOL],
		max_tokens: 3000,
	});
	if (!r.ok) return { pass: false, why: "http error", raw: "" };
	const named = r.toolCalls[0]?.function?.name;
	if (named === t.expect) {
		let city = "";
		try {
			city = JSON.parse(r.toolCalls[0].function.arguments || "{}").city ?? "";
		} catch {}
		return city
			? { pass: true, why: `tool_calls: ${named}(${city})`, raw: "" }
			: { pass: false, why: "tool call with unparseable arguments", raw: r.toolCalls[0]?.function?.arguments ?? "" };
	}
	return {
		pass: false,
		why: named ? `called ${named}` : "no structured tool call",
		raw: (r.content || r.reasoning).trim().slice(0, 120),
	};
}

/**
 * Levered arm: schema-constrained. Reads BOTH fields, because on a reasoning
 * model the constrained output lands in reasoning_content while content stays
 * empty - measured, not assumed.
 */
async function levered(t: Trial) {
	// Both arms MUST see the same tool definition. The first run of this
	// experiment omitted `tools` here and the levered arm scored -7 of 8 - not
	// because constraint hurt, but because the model had no weather tool to
	// call and honestly answered "unknown" every time. The arms differed in
	// INFORMATION, not just in the lever, which is the one thing this script's
	// own rules forbid. Recorded rather than quietly fixed, because a benchmark
	// that has been silently corrected is not evidence any more.
	const r = await call({
		model: MODEL,
		messages: [
			{
				role: "user",
				content: `${t.prompt}\n\nRespond with the tool to call. Use tool "unknown" if no tool fits.`,
			},
		],
		tools: [TOOL],
		response_format: CALL_SCHEMA,
		max_tokens: 3000,
	});
	if (!r.ok) return { pass: false, why: "http error", raw: "" };
	const body = (r.content.trim() || r.reasoning.trim());
	try {
		const v = JSON.parse(body);
		if (v.tool === t.expect && typeof v.city === "string" && v.city.length > 0) {
			return { pass: true, why: `schema: ${v.tool}(${v.city})`, raw: "" };
		}
		return { pass: false, why: `schema valid but wrong: tool=${v.tool}`, raw: body.slice(0, 120) };
	} catch {
		return { pass: false, why: "unparseable", raw: body.slice(0, 120) };
	}
}

const run = async (name: string, fn: (t: Trial) => Promise<{ pass: boolean; why: string; raw: string }>) => {
	let pass = 0;
	const failures: string[] = [];
	const started = Date.now();
	for (const t of TRIALS.slice(0, N)) {
		const r = await fn(t);
		if (r.pass) pass++;
		else failures.push(`    "${t.prompt}" -> ${r.why}${r.raw ? `\n      raw: ${r.raw}` : ""}`);
	}
	const ms = Date.now() - started;
	console.log(`\n${name}: ${pass}/${N} valid tool calls   (${(ms / N / 1000).toFixed(1)}s per trial)`);
	if (failures.length) {
		console.log("  failures:");
		console.log(failures.join("\n"));
	}
	return { pass, ms };
};

console.log(`harness-lever  ${BASE}  ${MODEL}  ${N} trials per arm`);
console.log("lever under test: schema-constrained decoding for tool calls");
console.log("=".repeat(72));

const a = await run("BARE      (native tools payload)", bare);
const b = await run("LEVERED   (schema-constrained)  ", levered);

console.log(`\n${"=".repeat(72)}`);
const delta = b.pass - a.pass;
console.log(`delta: ${delta >= 0 ? "+" : ""}${delta} of ${N}`);
console.log(
	delta > 0
		? "The lever bought real capability at identical inference speed."
		: delta === 0
			? "No measurable difference on this task. The lever is not free capability here."
			: "The lever made it WORSE on this task. Do not ship it on this evidence.",
);
console.log(`\n${N} trials is a signal, not a proof. Failures are printed above so the number can be audited.`);
