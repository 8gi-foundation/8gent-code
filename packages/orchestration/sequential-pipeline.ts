// 8gi:200-exempt — core HyperAgent pipeline, extracted from scripts/nightly-train.ts
// Sequential Multi-Inference Pipeline (Run D)
// Paper: arxiv 2603.28990v1 - fixed ordering + autonomous role selection
// Three passes: Analyst -> Critic -> Implementer

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────

export interface InferenceParams {
	temperature: number;
	num_predict: number;
	timeout: number;
}

export interface HyperAgentOptions {
	model?: string;
	inferenceMode?: "ollama" | "lmstudio" | "proxy";
	modelProxyUrl?: string;
	ollamaHost?: string;
	lmStudioHost?: string;
	vesselId?: string;
}

export interface RunCheckpoint {
	iteration: number;
	taskIndex: number;
	results: unknown[];
	startedAt: string;
	lastUpdated: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

export const MAX_ANALYST_RETRIES = 2;

const DEFAULT_CHECKPOINT_PATH = path.join(os.homedir(), ".8gent", "run-checkpoint.json");

// ── Default params ─────────────────────────────────────────────────────────

export function defaultParams(promptLength: number): InferenceParams {
	// Adaptive timeout: longer prompts need more thinking time
	// qwen3 thinking mode: ~1 token/30ms thinking + ~1 token/30ms content
	const baseTimeout = 180000; // 3 min minimum
	const perCharTimeout = Math.min(promptLength * 50, 420000); // scale with prompt, cap at 7 min extra
	return {
		temperature: 0.7,
		num_predict: 8192,
		timeout: baseTimeout + perCharTimeout,
	};
}

// ── inferenceChat ──────────────────────────────────────────────────────────
// Supports ollama | lmstudio | proxy backends

export async function inferenceChat(
	model: string,
	systemPrompt: string,
	userPrompt: string,
	params?: Partial<InferenceParams>,
	opts?: HyperAgentOptions,
): Promise<{ content: string; durationMs: number }> {
	const p = { ...defaultParams(userPrompt.length), ...params };
	const start = Date.now();

	// Resolve backend settings — opts override env vars
	const inferenceMode = opts?.inferenceMode || process.env.INFERENCE_MODE || "ollama";
	const modelProxyUrl =
		opts?.modelProxyUrl || process.env.MODEL_PROXY_URL || "http://8gi-model-proxy.internal:3200";
	const ollamaHost = opts?.ollamaHost || process.env.OLLAMA_HOST || "http://localhost:11434";
	const lmStudioHost = opts?.lmStudioHost || process.env.LM_STUDIO_HOST || "http://127.0.0.1:1234";
	const vesselId = opts?.vesselId || process.env.BOARD_MEMBER_CODE || "local";

	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), p.timeout);

		let content = "";

		if (inferenceMode === "proxy") {
			// Cloud mode: call OpenRouter directly for analyst/critic (bypasses proxy token limits)
			// The model-proxy is used by the harness-cli agent loop, not by pre-processing
			const openrouterKey = process.env.OPENROUTER_API_KEY || process.env.PROXY_API_KEY || "";
			const apiUrl = "https://openrouter.ai/api/v1/chat/completions";
			const authKey = openrouterKey;

			const res = await fetch(apiUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${authKey}`,
					"X-Vessel-ID": vesselId,
					"X-User-Id": vesselId,
				},
				body: JSON.stringify({
					model: model === "qwen3:14b" ? "auto:free" : model,
					messages: [
						{ role: "system", content: systemPrompt },
						{ role: "user", content: userPrompt },
					],
					max_tokens: p.num_predict,
					temperature: p.temperature,
				}),
				signal: controller.signal,
			});
			clearTimeout(timer);
			const data = (await res.json()) as any;
			content = data.choices?.[0]?.message?.content || "";
		} else if (inferenceMode === "lmstudio") {
			// LM Studio mode: OpenAI-compatible API at local port 1234
			const res = await fetch(`${lmStudioHost}/v1/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer lm-studio",
				},
				body: JSON.stringify({
					model,
					messages: [
						{ role: "system", content: systemPrompt },
						{ role: "user", content: userPrompt },
					],
					max_tokens: p.num_predict,
					temperature: p.temperature,
					stream: false,
				}),
				signal: controller.signal,
			});
			clearTimeout(timer);
			const data = (await res.json()) as any;
			content = data.choices?.[0]?.message?.content || "";
		} else {
			// Local mode: use Ollama directly
			const res = await fetch(`${ollamaHost}/api/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model,
					messages: [
						{ role: "system", content: systemPrompt },
						{ role: "user", content: userPrompt },
					],
					stream: false,
					options: { temperature: p.temperature, num_predict: p.num_predict },
				}),
				signal: controller.signal,
			});
			clearTimeout(timer);
			const data = (await res.json()) as any;
			content = data.message?.content || "";
		}

		return { content, durationMs: Date.now() - start };
	} catch (err) {
		console.error(`    inferenceChat error: ${err}`);
		return { content: "", durationMs: Date.now() - start };
	}
}

// ── adaptiveSequentialPreProcess ───────────────────────────────────────────
// Analyst → Critic (no-BS) → retry if rejected → returns enhanced prompt for Implementer

export async function adaptiveSequentialPreProcess(
	model: string,
	taskPrompt: string,
	taskId: string,
	opts?: HyperAgentOptions,
): Promise<string> {
	// --- Pass 1: Analyst (with retry on empty/timeout) ---
	let analysis = "";
	let analystAttempt = 0;
	let analystParams: Partial<InferenceParams> = {};

	while (analystAttempt < MAX_ANALYST_RETRIES && !analysis) {
		analystAttempt++;
		if (analystAttempt > 1) {
			// Self-improve: increase timeout, raise temperature for diversity
			analystParams = {
				timeout: (analystParams.timeout || defaultParams(taskPrompt.length).timeout) * 1.5,
				temperature: Math.min(0.9, (analystParams.temperature || 0.7) + 0.1),
			};
			console.log(
				`  [HYPER] Analyst retry ${analystAttempt} - timeout: ${Math.round((analystParams.timeout || 0) / 1000)}s, temp: ${analystParams.temperature}`,
			);
		}

		console.log(`  [SEQ] Pass 1: Analyst for ${taskId} (attempt ${analystAttempt})`);
		const result = await inferenceChat(
			model,
			`You are an Analyst. Your ONLY job is to identify the transformation rule or algorithm required.
Be precise. State the rule in formal terms. Do NOT write code. Do NOT implement anything.
Keep your response under 500 words.
Output format:
RULE: <one sentence formal description>
EVIDENCE: <which examples prove this rule>
EDGE CASES: <what could go wrong>`,
			taskPrompt,
			analystParams,
			opts,
		);
		analysis = result.content;
		console.log(
			`  [SEQ] Pass 1 complete (${analysis.length} chars, ${Math.round(result.durationMs / 1000)}s)`,
		);
	}

	if (!analysis) {
		console.log(
			`  [HYPER] Analyst failed after ${MAX_ANALYST_RETRIES} attempts - falling back to direct mode`,
		);
		return taskPrompt; // Fall back to non-sequential mode
	}

	// --- Pass 2: Critic (no-BS mode) ---
	console.log(`  [SEQ] Pass 2: Critic for ${taskId}`);
	const critiqueResult = await inferenceChat(
		model,
		`You are a Critic operating in no-BS mode. You receive an Analyst's rule identification and the original problem.
Your ONLY job is to find flaws, missed cases, or errors in the analysis.
Be harsh. Be specific. Do not let sloppy analysis pass.
If the analysis is WRONG, say REJECTED and explain why.
If the analysis is CORRECT, say APPROVED and list implementation pitfalls.
Keep your response under 300 words.
Output format:
VERDICT: APPROVED or REJECTED
FLAWS: <list specific errors or gaps, or "None" if approved>
CORRECTIONS: <what the rule actually is, if different>
IMPLEMENTATION RISKS: <what will go wrong when coding this>`,
		`ORIGINAL PROBLEM:\n${taskPrompt}\n\nANALYST OUTPUT:\n${analysis}`,
		undefined,
		opts,
	);

	const critique = critiqueResult.content;
	console.log(
		`  [SEQ] Pass 2 complete (${critique.length} chars, ${Math.round(critiqueResult.durationMs / 1000)}s)`,
	);

	// --- Critic rejection triggers analyst retry ---
	if (critique.includes("REJECTED") && analystAttempt < MAX_ANALYST_RETRIES) {
		console.log("  [HYPER] Critic REJECTED analysis - retrying analyst with critique feedback");
		const retryResult = await inferenceChat(
			model,
			`You are an Analyst. Your previous analysis was REJECTED by a critic.
Read the critic's feedback carefully and provide a corrected analysis.
Be precise. State the rule in formal terms. Do NOT write code.
Keep your response under 500 words.
Output format:
RULE: <corrected one sentence formal description>
EVIDENCE: <which examples prove this rule>
EDGE CASES: <what could go wrong>`,
			`ORIGINAL PROBLEM:\n${taskPrompt}\n\nYOUR PREVIOUS ANALYSIS:\n${analysis}\n\nCRITIC FEEDBACK:\n${critique}`,
			{ temperature: 0.5 }, // Lower temp for corrected analysis
			opts,
		);

		if (retryResult.content) {
			console.log(
				`  [HYPER] Analyst correction complete (${retryResult.content.length} chars, ${Math.round(retryResult.durationMs / 1000)}s)`,
			);
			analysis = retryResult.content;
		}
	}

	// --- Build enhanced prompt for Implementer ---
	const enhancedPrompt = `${taskPrompt}

--- ANALYST REPORT ---
${analysis}

--- CRITIC REVIEW ---
${critique}

--- IMPLEMENTATION DIRECTIVE ---
You have received analysis and critique from two prior reviewers. Use their insights to write a correct implementation. If the critic found flaws in the analysis, trust the critic's corrections. Write the code, run tests, verify correctness.`;

	return enhancedPrompt;
}

// ── Checkpoint persistence ─────────────────────────────────────────────────

export function saveCheckpoint(cp: RunCheckpoint, checkpointPath?: string): void {
	fs.writeFileSync(checkpointPath || DEFAULT_CHECKPOINT_PATH, JSON.stringify(cp, null, 2));
}

export function loadCheckpoint(checkpointPath?: string): RunCheckpoint | null {
	const p = checkpointPath || DEFAULT_CHECKPOINT_PATH;
	try {
		if (fs.existsSync(p)) {
			const data = JSON.parse(fs.readFileSync(p, "utf-8"));
			return data as RunCheckpoint;
		}
	} catch {
		/* corrupted checkpoint, start fresh */
	}
	return null;
}

export function clearCheckpoint(checkpointPath?: string): void {
	try {
		fs.unlinkSync(checkpointPath || DEFAULT_CHECKPOINT_PATH);
	} catch {
		/* ok */
	}
}

// ── critiqueResponse ───────────────────────────────────────────────────────
// Run D critic pattern: qwen3:32b scores a Gemma 4 response.
// Returns { approved, feedback } — caller decides whether to retry.

const CRITIC_SYSTEM = `You are a Critic. Your job is to evaluate a response for correctness, completeness, and clarity.
Be concise and harsh. One retry budget — make the feedback count.
Output format (exact):
VERDICT: APPROVED or REJECTED
FLAWS: <specific issues, or "None">
FIX: <what to change in one sentence, or "N/A">`;

export async function critiqueResponse(
	query: string,
	response: string,
	ollamaHost = "http://localhost:11434",
): Promise<{ approved: boolean; feedback: string }> {
	try {
		const result = await inferenceChat(
			"qwen3:32b",
			CRITIC_SYSTEM,
			`QUERY: ${query}\n\nRESPONSE: ${response}`,
			{ num_predict: 300, temperature: 0.3, timeout: 30000 },
			{ inferenceMode: "ollama", ollamaHost },
		);
		const approved = !result.content.includes("REJECTED");
		return { approved, feedback: result.content };
	} catch {
		// Critic unavailable — approve by default (don't block the user)
		return { approved: true, feedback: "" };
	}
}
