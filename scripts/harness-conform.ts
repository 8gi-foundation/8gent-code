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

	// ---- Stage 4: does the server serve the model you asked for? -----------
	// Found the hard way against LM Studio: a model id that does not exist is
	// answered by whatever happens to be loaded, with HTTP 200 and no warning.
	// The consequence is worse than a bad error message - an eval can score a
	// model it never selected, and every number it produces is about something
	// else. Checked separately from error quality because this one silently
	// corrupts results rather than merely being unhelpful.
	{
		const bogus = "conformance-probe-model-that-does-not-exist";
		try {
			const { res, json, ms } = await post(o, "/v1/chat/completions", {
				model: bogus,
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 8,
			});
			const served: string = typeof json?.model === "string" ? json.model : "";
			const substituted = res.ok && served !== "" && served !== bogus;
			add({
				stage: 4,
				id: "model-substitution",
				proves: "the server answers as the model you asked for, or refuses",
				status: !res.ok ? "pass" : substituted ? "fail" : "fail",
				detail: !res.ok
					? `refused an unknown model with http ${res.status}, which is correct`
					: substituted
						? `asked for "${bogus}", answered by "${served}" with http 200: a typo silently routes to the wrong model`
						: `accepted an unknown model with http 200 and named no model in the response`,
				ms,
			});
		} catch (e) {
			add({
				stage: 4,
				id: "model-substitution",
				proves: "the server answers as the model you asked for, or refuses",
				status: "skip",
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

const esc = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Render the run as a bench readout.
 *
 * Every value on the page comes from the run that just happened. There is no
 * sample data and no placeholder: a report that can render without a run is a
 * report that can lie about one.
 */
function renderHtml(o: Opts, checks: Check[], ranAt: string): string {
	const pass = checks.filter((c) => c.status === "pass").length;
	const fail = checks.filter((c) => c.status === "fail").length;
	const skip = checks.filter((c) => c.status === "skip").length;
	const slowest = Math.max(1, ...checks.map((c) => c.ms));

	const stages = [...new Set(checks.map((c) => c.stage))].sort((a, b) => a - b);

	const rows = stages
		.map((stage) => {
			const inStage = checks.filter((c) => c.stage === stage);
			const items = inStage
				.map((c) => {
					const width = Math.max(1.5, (c.ms / slowest) * 100);
					return `
        <li class="check ${c.status}">
          <span class="chip" aria-label="${c.status}">${c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : "INCONCLUSIVE"}</span>
          <div class="body">
            <p class="id">${esc(c.id)}</p>
            <p class="proves">proves &mdash; ${esc(c.proves)}</p>
            <p class="detail">${esc(c.detail)}</p>
          </div>
          <div class="timing">
            <span class="ms">${c.ms.toLocaleString()}<abbr>ms</abbr></span>
            <span class="bar"><i style="width:${width.toFixed(1)}%"></i></span>
          </div>
        </li>`;
				})
				.join("");
			return `
      <section class="stage">
        <h2><span class="num">${stage}</span>${esc(STAGES[stage] ?? `Stage ${stage}`)}</h2>
        <ol class="checks">${items}</ol>
      </section>`;
		})
		.join("");

	return `<title>Harness Conformance Readout</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:ital,wght@0,400;1,400&display=swap">
<style>
  :root {
    --ground:#ECEEF1; --surface:#FFFFFF; --sunk:#E3E7EC;
    --ink:#12161B; --dim:#5A646F; --rule:#D3D9E0;
    --accent:#B26A00;
    --pass:#1F7A4D; --fail:#B3261E; --skip:#6B6257;
    --display:'Archivo',system-ui,sans-serif;
    --prose:'IBM Plex Sans',system-ui,sans-serif;
    --data:'IBM Plex Mono',ui-monospace,monospace;
  }
  @media (prefers-color-scheme:dark){
    :root:not([data-theme="light"]){
      --ground:#0D1117; --surface:#151A21; --sunk:#10151B;
      --ink:#E4E8ED; --dim:#8792A0; --rule:#232A33;
      --accent:#E9A13B; --pass:#4FBF85; --fail:#F0736A; --skip:#9A9086;
    }
  }
  :root[data-theme="dark"]{
    --ground:#0D1117; --surface:#151A21; --sunk:#10151B;
    --ink:#E4E8ED; --dim:#8792A0; --rule:#232A33;
    --accent:#E9A13B; --pass:#4FBF85; --fail:#F0736A; --skip:#9A9086;
  }
  *{box-sizing:border-box}
  body{
    margin:0; background:var(--ground); color:var(--ink);
    font-family:var(--prose); line-height:1.55;
    -webkit-font-smoothing:antialiased;
  }
  .wrap{max-width:70rem; margin:0 auto; padding:clamp(1.5rem,4vw,3.5rem) clamp(1rem,4vw,2.5rem) 5rem}

  header{border-bottom:2px solid var(--ink); padding-bottom:1.25rem; margin-bottom:2rem}
  .eyebrow{
    font-family:var(--data); font-size:.7rem; letter-spacing:.14em;
    text-transform:uppercase; color:var(--accent); margin:0 0 .5rem;
  }
  h1{
    font-family:var(--display); font-weight:700; font-size:clamp(1.9rem,5vw,3rem);
    letter-spacing:-.02em; line-height:1.05; margin:0; text-wrap:balance;
  }
  .target{
    font-family:var(--data); font-size:.85rem; color:var(--dim);
    margin:.65rem 0 0; word-break:break-all;
  }

  .verdict{
    display:flex; flex-wrap:wrap; gap:0; margin:0 0 2.5rem;
    border:1px solid var(--rule); background:var(--surface);
  }
  .verdict div{
    flex:1 1 7rem; padding:.9rem 1.1rem; border-right:1px solid var(--rule);
  }
  .verdict div:last-child{border-right:0}
  .verdict dt{
    font-family:var(--data); font-size:.65rem; letter-spacing:.12em;
    text-transform:uppercase; color:var(--dim); margin:0 0 .25rem;
  }
  .verdict dd{
    margin:0; font-family:var(--display); font-weight:700; font-size:1.75rem;
    font-variant-numeric:tabular-nums; line-height:1;
  }
  .v-pass dd{color:var(--pass)} .v-fail dd{color:var(--fail)} .v-skip dd{color:var(--skip)}

  .stage{margin:0 0 2.25rem}
  .stage h2{
    font-family:var(--display); font-weight:500; font-size:.95rem;
    letter-spacing:.02em; margin:0 0 .6rem; display:flex; align-items:center; gap:.6rem;
    color:var(--dim); text-transform:uppercase;
  }
  .num{
    font-family:var(--data); font-size:.75rem; color:var(--ground);
    background:var(--ink); width:1.5rem; height:1.5rem;
    display:grid; place-items:center; flex:none;
  }
  .checks{list-style:none; margin:0; padding:0; border:1px solid var(--rule); background:var(--surface)}
  .check{
    display:grid; grid-template-columns:7.5rem 1fr 8rem; gap:1rem;
    padding:.9rem 1.1rem; border-bottom:1px solid var(--rule); align-items:start;
  }
  .check:last-child{border-bottom:0}
  @media (max-width:44rem){
    .check{grid-template-columns:1fr; gap:.5rem}
    .timing{justify-self:start}
  }
  .chip{
    font-family:var(--data); font-size:.62rem; letter-spacing:.1em;
    padding:.3rem .5rem; border:1px solid currentColor; white-space:nowrap;
    align-self:start; display:inline-block;
  }
  .pass .chip{color:var(--pass)} .fail .chip{color:var(--fail)} .skip .chip{color:var(--skip)}
  .fail{background:color-mix(in srgb, var(--fail) 5%, transparent)}
  .body p{margin:0}
  .id{font-family:var(--data); font-size:.92rem; font-weight:500}
  .proves{font-family:var(--prose); font-style:italic; color:var(--dim); font-size:.85rem; margin-top:.15rem}
  .detail{
    font-family:var(--data); font-size:.8rem; margin-top:.45rem;
    background:var(--sunk); padding:.45rem .6rem; overflow-x:auto; white-space:pre-wrap;
  }
  .timing{display:flex; flex-direction:column; gap:.35rem; align-items:flex-end}
  @media (max-width:44rem){.timing{align-items:flex-start}}
  .ms{font-family:var(--data); font-size:.85rem; font-variant-numeric:tabular-nums}
  .ms abbr{color:var(--dim); font-size:.7em; margin-left:.1em; text-decoration:none}
  .bar{display:block; width:100%; min-width:5rem; height:3px; background:var(--sunk)}
  .bar i{display:block; height:100%; background:var(--accent)}

  footer{
    margin-top:2.5rem; padding-top:1.25rem; border-top:1px solid var(--rule);
    color:var(--dim); font-size:.85rem; max-width:62ch;
  }
  footer strong{color:var(--ink); font-weight:500}
</style>
<div class="wrap">
  <header>
    <p class="eyebrow">Harness conformance &middot; live run</p>
    <h1>What this endpoint can actually do</h1>
    <p class="target">${esc(o.base)} &nbsp;&middot;&nbsp; ${esc(o.model || "auto-detected")} &nbsp;&middot;&nbsp; ${esc(ranAt)}</p>
  </header>

  <dl class="verdict">
    <div class="v-pass"><dt>Passed</dt><dd>${pass}</dd></div>
    <div class="v-fail"><dt>Failed</dt><dd>${fail}</dd></div>
    <div class="v-skip"><dt>Inconclusive</dt><dd>${skip}</dd></div>
    <div><dt>Slowest</dt><dd>${slowest.toLocaleString()}<abbr style="font-size:.55em;color:var(--dim)">ms</abbr></dd></div>
  </dl>

  ${rows}

  <footer>
    <p><strong>Inconclusive is not a pass.</strong> A check that could not run says so. A tool that reports green when it did not look manufactures confidence, which is the same defect as a liveness probe standing in for a readiness one.</p>
    <p>Every figure on this page came from the run named above. Nothing here is sample data.</p>
  </footer>
</div>`;
}

const opts = parseArgs(process.argv.slice(2));
const ranAt = new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
const checks = await run(opts);

if (opts.json) {
	console.log(JSON.stringify({ base: opts.base, model: opts.model, ranAt, checks }, null, 2));
} else {
	console.log(renderText(opts, checks));
}

if (opts.html) {
	await Bun.write(opts.html, renderHtml(opts, checks, ranAt));
	console.log(`html report -> ${opts.html}`);
}

process.exit(checks.some((c) => c.status === "fail") ? 1 : 0);
