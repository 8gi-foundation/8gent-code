/**
 * FailoverJudge - real-backend Judge for the GoalLoop.
 *
 * Uses `packages/providers/failover.ts` to resolve the judge model from the
 * local-first chain (apfel → ollama → lmstudio → cloud last-resort) and
 * calls that model with a structured-output prompt. Returns a JudgeVerdict.
 *
 * Boardroom-mandated principles (do not relax without re-running the
 * mitigation gate):
 *   - JUDGE FAILS OPEN. Any error (timeout, malformed JSON, unreachable
 *     model, parse failure) returns a `continue`-equivalent verdict with
 *     `confidence: 0`. The judge MUST NEVER wedge the loop; budget caps
 *     handle the real bound. Refinement comment #4467176878.
 *   - ANTI-COLLUSION. Constructor rejects if judgeModel === executorModel.
 *     Same-model judging defeats the purpose of an external judge.
 *
 * Criterion extraction: at construction the goal text is rewritten into a
 * single falsifiable success criterion via the same failover chain. If
 * extraction fails, we fall back to the raw goal as the criterion.
 */

import { type FailoverChannel, ModelFailover } from "../providers/failover";
import { createClient } from "../eight/clients";
import type { AgentConfig, LLMClient, Message } from "../eight/types";
import { assertDistinctJudge } from "./judge";
import type { JudgeHandle, JudgeHandleInput, JudgeVerdict } from "./types";

export interface FailoverJudgeOptions {
	/** Executor model id - used for the anti-collusion constructor check. */
	executorModel: string;
	/**
	 * Preferred judge model. The failover chain resolves this to the first
	 * healthy provider/model pair. If omitted, defaults to the head of the
	 * local-first text chain that is NOT the executor model.
	 */
	judgeModel?: string;
	/** Channel ("text" | "computer"). Defaults to "text". */
	channel?: FailoverChannel;
	/** Pre-built failover instance (tests inject). */
	failover?: ModelFailover;
	/**
	 * Client factory. Production: `createClient` from `packages/eight/clients`.
	 * Tests inject a stub returning a fake LLMClient.
	 */
	clientFactory?: (cfg: { runtime: AgentConfig["runtime"]; model: string }) => LLMClient;
	/** Per-call timeout in ms. Default 30s. */
	timeoutMs?: number;
}

const DEFAULT_LOCAL_JUDGE = "apple-foundationmodel";

const JUDGE_PROMPT_TEMPLATE = (args: {
	goalText: string;
	turnSummary: string;
	criterion: string;
}) =>
	`You are an unbiased completion judge. The agent is working on:
  GOAL: ${args.goalText}
The agent just produced this turn (summary, NOT raw tool output):
  TURN_SUMMARY: ${args.turnSummary}
Falsifiable success criterion (extracted at goal-start):
  CRITERION: ${args.criterion}
Return ONLY this JSON, no prose:
  {"done": true|false, "confidence": 0..1, "reason": "<one short sentence, no AI-speak>"}`;

const CRITERION_PROMPT = (goal: string) =>
	`Rewrite the following goal as ONE short falsifiable success criterion. ` +
		`Return ONLY the criterion as a single sentence, no quotes, no preamble, no em dashes.\n\n` +
		`GOAL: ${goal.trim()}`;

/**
 * Map ProviderName (failover output) to the AgentConfig.runtime literal
 * createClient understands. Mirrors clients/index.ts:runtimeForProvider but
 * inlined here so this module doesn't depend on the role-config path.
 */
function runtimeForProvider(provider: string): AgentConfig["runtime"] {
	switch (provider) {
		case "apple-foundation":
			return "apple-foundation";
		case "apfel":
			return "apfel";
		case "deepseek":
			return "deepseek";
		case "ollama":
		case "8gent":
			return "ollama";
		case "lmstudio":
			return "lmstudio";
		case "openrouter":
			return "openrouter";
		// Hosted providers (groq, grok, openai, anthropic, mistral, together,
		// fireworks, replicate) all reach the model via openrouter as the
		// default proxy here — AgentConfig.runtime is the narrow set.
		default:
			return "openrouter";
	}
}

/**
 * Run a promise with a timeout. Resolves with the value, or rejects with a
 * timeout error. The judge wraps every call so a hung local model cannot
 * wedge the goal loop.
 */
async function withTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race<T>([
			p,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${tag} timed out after ${ms}ms`)),
					ms,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Parse the {"done":..., "confidence":..., "reason":"..."} envelope returned
 * by the judge model. Tolerant of code-fence wrapping and surrounding prose.
 * Throws on malformed input; caller turns the throw into a fail-open verdict.
 */
export function parseJudgeJson(raw: string): {
	done: boolean;
	confidence: number;
	reason: string;
} {
	if (typeof raw !== "string" || !raw.trim()) {
		throw new Error("judge returned empty response");
	}
	// Strip fenced blocks if present.
	const stripped = raw
		.replace(/^```(?:json)?\s*/im, "")
		.replace(/```\s*$/m, "")
		.trim();
	// Find the first {...} JSON object. Models often add chatter despite
	// instructions; grab the first balanced object.
	const start = stripped.indexOf("{");
	const end = stripped.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) {
		throw new Error("judge response contained no JSON object");
	}
	const slice = stripped.slice(start, end + 1);
	const parsed = JSON.parse(slice);
	if (!parsed || typeof parsed !== "object") {
		throw new Error("judge JSON did not parse to an object");
	}
	const done = parsed.done;
	const confidence = parsed.confidence;
	const reason = parsed.reason;
	if (typeof done !== "boolean") {
		throw new Error(`judge.done must be boolean, got ${typeof done}`);
	}
	if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) {
		throw new Error(`judge.confidence must be number in [0,1], got ${String(confidence)}`);
	}
	const reasonStr = typeof reason === "string" && reason.trim()
		? reason.trim()
		: "no reason provided";
	return { done, confidence, reason: reasonStr };
}

export class FailoverJudge implements JudgeHandle {
	readonly model: string;
	private readonly failover: ModelFailover;
	private readonly channel: FailoverChannel;
	private readonly clientFactory: NonNullable<FailoverJudgeOptions["clientFactory"]>;
	private readonly timeoutMs: number;
	private readonly goalCriteria = new Map<string, string>();

	constructor(opts: FailoverJudgeOptions) {
		const requestedJudge = (opts.judgeModel ?? DEFAULT_LOCAL_JUDGE).trim();
		// Anti-collusion: judge MUST differ from executor. Reuses the same
		// equality check used in GoalLoop construction for consistency.
		assertDistinctJudge(opts.executorModel, requestedJudge);
		this.model = requestedJudge;
		this.failover = opts.failover ?? new ModelFailover();
		this.channel = opts.channel ?? "text";
		this.clientFactory =
			opts.clientFactory ??
			((cfg) => createClient({ runtime: cfg.runtime, model: cfg.model }));
		this.timeoutMs = opts.timeoutMs ?? 30_000;
	}

	async score(input: JudgeHandleInput): Promise<JudgeVerdict> {
		// 1. Ensure we have a falsifiable criterion for this goal. Extracted
		//    once per goal, cached. Falls back to the raw goal on failure.
		const criterion = await this.ensureCriterion(input.goal);

		// 2. Resolve the judge model through the failover chain. We always
		//    re-resolve so a marked-down model picks up the next tier.
		const entry = this.failover.resolve(this.model, this.channel);
		const runtime = runtimeForProvider(entry.provider);
		const client = this.clientFactory({ runtime, model: entry.model });

		// 3. Build the prompt + call the model. Any failure -> fail open.
		const prompt = JUDGE_PROMPT_TEMPLATE({
			goalText: input.goal,
			turnSummary: input.executorOutput.summary,
			criterion,
		});

		let raw: string;
		try {
			raw = await withTimeout(this.invoke(client, prompt), this.timeoutMs, "judge");
		} catch (err) {
			this.failover.markDown(entry.model, entry.provider);
			return openVerdict(`judge unavailable, deferring to budget (${errorMessage(err)})`);
		}

		try {
			const parsed = parseJudgeJson(raw);
			return {
				decision: parsed.done ? "satisfied" : "continue",
				confidence: parsed.confidence,
				summary: scrub(parsed.reason),
			};
		} catch (err) {
			return openVerdict(`judge unavailable, deferring to budget (${errorMessage(err)})`);
		}
	}

	/**
	 * Extract a single falsifiable criterion from the goal text. Cached per
	 * goal so we don't pay the extraction cost on every turn. Falls back to
	 * the goal itself on failure (still a usable criterion for the judge).
	 */
	private async ensureCriterion(goal: string): Promise<string> {
		const cached = this.goalCriteria.get(goal);
		if (cached) return cached;

		const entry = this.failover.resolve(this.model, this.channel);
		const runtime = runtimeForProvider(entry.provider);
		const client = this.clientFactory({ runtime, model: entry.model });

		let criterion: string;
		try {
			const raw = await withTimeout(
				this.invoke(client, CRITERION_PROMPT(goal)),
				this.timeoutMs,
				"criterion-extraction",
			);
			const trimmed = (raw ?? "").trim().replace(/—/g, "-");
			criterion = trimmed.length > 0 ? oneLine(trimmed) : goal.trim();
		} catch {
			criterion = goal.trim();
		}
		this.goalCriteria.set(goal, criterion);
		return criterion;
	}

	/**
	 * Call the underlying client. Prefers `.generate()` (single-shot prompt)
	 * but falls back to `.chat()` for clients that don't support the prompt
	 * shortcut. The judge prompt is small enough that either path is fine.
	 */
	private async invoke(client: LLMClient, prompt: string): Promise<string> {
		try {
			const out = await client.generate(prompt);
			if (typeof out === "string" && out.trim()) return out;
			// Some clients return "" when their server has nothing; fall
			// through to chat() to retry on the explicit message shape.
		} catch {
			// fall through to chat() retry
		}
		const messages: Message[] = [{ role: "user", content: prompt }];
		const res = await client.chat(messages);
		return res?.message?.content ?? "";
	}
}

/**
 * Fail-open verdict factory. Confidence 0 + `continue` decision means the
 * GoalLoop keeps working until a hard budget cap fires. No em dashes.
 */
function openVerdict(reason: string): JudgeVerdict {
	return {
		decision: "continue",
		confidence: 0,
		summary: scrub(reason),
	};
}

function errorMessage(err: unknown): string {
	const msg = err instanceof Error ? err.message : String(err);
	// Keep the failure reason short; the loop logs it via the event sink.
	return msg.length > 120 ? `${msg.slice(0, 117)}...` : msg;
}

/** Strip em dashes and collapse to a single line for the verdict summary. */
function scrub(text: string): string {
	return text.replace(/—/g, "-").replace(/\s+/g, " ").trim();
}

function oneLine(text: string): string {
	const firstLine = text.split(/\r?\n/)[0] ?? text;
	return firstLine.trim();
}
