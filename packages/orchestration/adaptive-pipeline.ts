/**
 * adaptive-pipeline.ts - adaptive three-model build pipeline.
 *
 * First-principles design. A pipeline runs ordered STAGES across the local
 * models. Any stage can hit an OBSTACLE. Every obstacle has a TYPE and a
 * graded SEVERITY. A deterministic DECISION PALETTE maps (obstacle, attempt)
 * to a recovery STRATEGY - the same obstacle always yields the same decision.
 * The pipeline applies the strategy, adjusts the stage's config, and
 * re-attempts. Harder obstacles escalate to stronger models: the pipeline
 * leverages the intelligence on hand adaptively rather than uniformly.
 *
 * Obstacle severity ladder:
 *   1 TRIVIAL  - transient (timeout, empty output)      -> retry
 *   2 MODERATE - recoverable by config change           -> shrink input / raise budget
 *   3 SEVERE   - needs different intelligence            -> escalate model / repair
 *   4 BLOCKING - unrecoverable                           -> abort, keep best artifact
 *
 * Proven across 8 AutoResearch rounds (benchmarks/autoresearch).
 */

import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectLocalModels } from "./local-model-detect.js";
import { loadRoleConfig, type RoleModelAssignment } from "./role-config.js";

const OLLAMA_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const LMSTUDIO_URL = process.env.LMSTUDIO_BASE_URL || "http://localhost:1234/v1";
const BRIDGE_PATH =
	process.env.APPLE_FOUNDATION_BRIDGE ||
	join(homedir(), ".8gent", "bin", "apple-foundation-bridge");
const CALL_TIMEOUT_MS = 480_000;

// ======================================================================
// Obstacle taxonomy
// ======================================================================

export enum ObstacleType {
	ProviderUnhealthy = "provider-unhealthy",
	Timeout = "timeout",
	EmptyOutput = "empty-output",
	ContextOverflow = "context-overflow",
	Truncation = "truncation",
	SyntaxError = "syntax-error",
	QualityDefect = "quality-defect",
}

export enum Severity {
	Trivial = 1,
	Moderate = 2,
	Severe = 3,
	Blocking = 4,
}

/** A concrete problem encountered by a stage, graded by severity. */
export class Obstacle {
	constructor(
		readonly type: ObstacleType,
		readonly severity: Severity,
		readonly detail: string,
	) {}

	toString(): string {
		return `[${Severity[this.severity]}] ${this.type}: ${this.detail}`;
	}
}

// ======================================================================
// Intelligence: models ranked by capability
// ======================================================================

/** A callable local model with a capability score (higher = stronger). */
export class Model {
	constructor(
		readonly provider: RoleModelAssignment["provider"],
		readonly model: string,
		readonly score: number,
	) {}

	get key(): string {
		return `${this.provider}:${this.model}`;
	}

	async call(system: string, user: string, budget: number): Promise<string> {
		if (this.provider === "ollama" || this.provider === "8gent") {
			return callOllama(this.model, system, user, budget);
		}
		if (this.provider === "lmstudio") return callLMStudio(this.model, system, user, budget);
		if (this.provider === "apple-foundation" || this.provider === "apfel") {
			return callAppleFoundation(system, user);
		}
		throw new Error(`adaptive-pipeline cannot drive provider '${this.provider}'`);
	}

	/** Free this model from memory when it is an Ollama model (RAM time-share). */
	async release(): Promise<void> {
		if (this.provider === "ollama" || this.provider === "8gent") {
			await unloadOllama(this.model);
		}
	}
}

/**
 * The intelligence on hand. Knows which models are healthy and how strong
 * each is, so the pipeline can escalate to a stronger model on demand.
 */
export class ModelRoster {
	private constructor(readonly models: Model[]) {}

	/** Probe the local hosts and build a roster of healthy models. */
	static async detect(): Promise<ModelRoster> {
		const detected = await detectLocalModels();
		const models = detected.map((d) => new Model(d.provider, d.model, d.score));
		return new ModelRoster(models.sort((a, b) => b.score - a.score));
	}

	isHealthy(provider: string, model: string): boolean {
		// Apple Foundation has no /models endpoint; trust the bridge probe.
		if (provider === "apple-foundation" || provider === "apfel") {
			return this.models.some((m) => m.provider === "apple-foundation");
		}
		return this.models.some((m) => m.provider === provider && m.model === model);
	}

	strongest(): Model | undefined {
		return this.models[0];
	}

	/** The strongest model strictly stronger than `current`, if any. */
	strongerThan(current: Model): Model | undefined {
		return this.models.find((m) => m.score > current.score);
	}

	find(provider: string, model: string): Model | undefined {
		return this.models.find((m) => m.provider === provider && m.model === model);
	}
}

// ======================================================================
// Decision palette: obstacle -> recovery strategy (deterministic)
// ======================================================================

export type Strategy =
	| "retry"
	| "reassign"
	| "escalate"
	| "shrink-input"
	| "raise-budget"
	| "repair"
	| "skip"
	| "abort";

export class Decision {
	constructor(
		readonly strategy: Strategy,
		readonly rationale: string,
	) {}
}

/**
 * The select palette of decision-making. A pure, deterministic map from
 * (obstacle, attempt index) to a strategy. The same obstacle at the same
 * attempt always yields the same decision - no randomness, fully replayable.
 */
export class DecisionPalette {
	constructor(private readonly maxAttempts = 3) {}

	decide(obstacle: Obstacle, attempt: number, essential: boolean): Decision {
		// Budget exhausted: a non-essential stage is skipped, an essential
		// one aborts (the pipeline keeps the best artifact it has).
		if (attempt >= this.maxAttempts) {
			return essential
				? new Decision("abort", `attempt budget spent on essential stage`)
				: new Decision("skip", `attempt budget spent on optional stage`);
		}

		switch (obstacle.type) {
			case ObstacleType.ProviderUnhealthy:
				return new Decision("reassign", "provider is down - route to a healthy model");

			case ObstacleType.Timeout:
				// Transient first, structural if it persists.
				return attempt === 0
					? new Decision("retry", "first timeout - retry as transient")
					: new Decision("escalate", "repeated timeout - try a different model");

			case ObstacleType.EmptyOutput:
				return attempt === 0
					? new Decision("retry", "empty output - retry once")
					: new Decision("escalate", "still empty - escalate to a stronger model");

			case ObstacleType.ContextOverflow:
				return new Decision("shrink-input", "input exceeds the model context window");

			case ObstacleType.Truncation:
				return attempt === 0
					? new Decision("raise-budget", "output truncated - raise the token budget")
					: new Decision("escalate", "still truncated - escalate to a stronger model");

			case ObstacleType.SyntaxError:
			case ObstacleType.QualityDefect:
				// Needs different intelligence applied to the artifact.
				return new Decision("repair", "defective artifact - run a review+repair cycle");

			default:
				return new Decision("abort", "unclassified obstacle");
		}
	}
}

// ======================================================================
// Obstacle classifier
// ======================================================================

/** Inspects stage output (or a thrown error) and grades any obstacle. */
export class ObstacleClassifier {
	/** Classify a failed/again-needed call. Returns null when output is clean. */
	classify(error: string | null, output: string, opts: { code: boolean }): Obstacle | null {
		if (error) {
			if (/exceededContextWindowSize|context window|maximum.*token/i.test(error))
				return new Obstacle(ObstacleType.ContextOverflow, Severity.Moderate, error.slice(0, 160));
			if (/timed out|timeout|aborted/i.test(error))
				return new Obstacle(ObstacleType.Timeout, Severity.Trivial, error.slice(0, 160));
			if (/compute error|ECONNREFUSED|fetch failed|50\d|not healthy/i.test(error))
				return new Obstacle(ObstacleType.ProviderUnhealthy, Severity.Severe, error.slice(0, 160));
			return new Obstacle(ObstacleType.EmptyOutput, Severity.Moderate, error.slice(0, 160));
		}
		if (output.trim().length < 80)
			return new Obstacle(ObstacleType.EmptyOutput, Severity.Moderate, "output near-empty");
		if (!opts.code) return null; // non-code stages: presence is enough

		const defects = staticChecks(output);
		if (defects.length === 0) return null;
		if (defects.some((d) => /TRUNCATED/.test(d)))
			return new Obstacle(ObstacleType.Truncation, Severity.Moderate, defects.join("; "));
		if (defects.some((d) => /SYNTAX ERROR/.test(d)))
			return new Obstacle(ObstacleType.SyntaxError, Severity.Severe, defects.join("; "));
		return new Obstacle(ObstacleType.QualityDefect, Severity.Severe, defects.join("; "));
	}
}

// ======================================================================
// Stages
// ======================================================================

export interface StageRecord {
	stage: string;
	provider: string;
	model: string;
	attempts: number;
	ms: number;
	ok: boolean;
	obstacles: string[];
}

interface StageContext {
	task: string;
	design: string;
	plan: string;
	brief: string;
	artifact: string;
}

/** Build context shared and mutated across stages. */
class PipelineContext implements StageContext {
	task = "";
	design = "";
	plan = "";
	brief = "";
	artifact = "";
}

// ======================================================================
// The adaptive pipeline
// ======================================================================

export interface PipelineResult {
	artifact: string;
	ok: boolean;
	defects: string[];
	stages: StageRecord[];
	totalMs: number;
}

export interface PipelineOptions {
	task: string;
	maxAttempts?: number;
	onProgress?: (msg: string) => void;
}

/**
 * Adaptive three-model build pipeline. Runs plan -> compact -> engineer,
 * wrapping each stage in a deterministic self-correcting loop driven by the
 * obstacle classifier and the decision palette.
 */
export class AdaptivePipeline {
	private readonly log: (m: string) => void;
	private readonly classifier = new ObstacleClassifier();
	private readonly palette: DecisionPalette;

	constructor(
		private readonly roster: ModelRoster,
		opts: { maxAttempts?: number; onProgress?: (m: string) => void } = {},
	) {
		this.log = opts.onProgress ?? (() => {});
		this.palette = new DecisionPalette(opts.maxAttempts ?? 3);
	}

	/** Build a pipeline with a freshly detected roster. */
	static async create(opts: PipelineOptions): Promise<AdaptivePipeline> {
		const roster = await ModelRoster.detect();
		return new AdaptivePipeline(roster, opts);
	}

	/**
	 * Resolve a configured role to a healthy Model, falling back to the
	 * strongest detected model when the configured provider is down.
	 */
	private resolve(role: string, a: RoleModelAssignment): Model {
		if (this.roster.isHealthy(a.provider, a.model)) {
			return (
				this.roster.find(a.provider, a.model) ??
				new Model(a.provider, a.model, 0)
			);
		}
		const fallback = this.roster.strongest();
		if (!fallback) return new Model(a.provider, a.model, 0);
		this.log(`${role}: ${a.provider}/${a.model} unhealthy - using ${fallback.key}`);
		return fallback;
	}

	/**
	 * Run a stage inside the deterministic self-correcting loop. The loop
	 * re-attempts until the classifier finds no obstacle, or the decision
	 * palette returns abort/skip.
	 */
	private async runStage(
		name: string,
		model: Model,
		isCode: boolean,
		essential: boolean,
		build: (m: Model, budget: number, input: string) => Promise<string>,
		input: string,
		records: StageRecord[],
	): Promise<{ output: string; model: Model }> {
		const t0 = performance.now();
		const obstacles: string[] = [];
		let activeModel = model;
		let budget = isCode ? 16000 : 1500;
		let activeInput = input;
		let output = "";

		for (let attempt = 0; ; attempt++) {
			this.log(`${name}: ${activeModel.key} (attempt ${attempt + 1}) ...`);
			let error: string | null = null;
			try {
				output = await build(activeModel, budget, activeInput);
			} catch (err) {
				error = String(err);
				output = "";
			}

			const obstacle = this.classifier.classify(error, output, { code: isCode });
			if (!obstacle) {
				records.push({
					stage: name,
					provider: activeModel.provider,
					model: activeModel.model,
					attempts: attempt + 1,
					ms: Math.round(performance.now() - t0),
					ok: true,
					obstacles,
				});
				this.log(`${name}: clear (${output.length} chars)`);
				return { output, model: activeModel };
			}

			obstacles.push(obstacle.toString());
			const decision = this.palette.decide(obstacle, attempt, essential);
			this.log(`${name}: ${obstacle} -> ${decision.strategy} (${decision.rationale})`);

			switch (decision.strategy) {
				case "retry":
					break; // same config, attempt again
				case "reassign":
				case "escalate": {
					const stronger =
						decision.strategy === "escalate"
							? this.roster.strongerThan(activeModel) ?? this.roster.strongest()
							: this.roster.strongest();
					if (stronger && stronger.key !== activeModel.key) activeModel = stronger;
					break;
				}
				case "shrink-input":
					activeInput = activeInput.slice(0, Math.floor(activeInput.length * 0.55));
					break;
				case "raise-budget":
					budget = Math.min(budget * 2, 32000);
					break;
				case "repair":
					// Handled by the caller's repair loop, not here.
					records.push({
						stage: name,
						provider: activeModel.provider,
						model: activeModel.model,
						attempts: attempt + 1,
						ms: Math.round(performance.now() - t0),
						ok: false,
						obstacles,
					});
					return { output, model: activeModel };
				case "skip":
				case "abort":
					records.push({
						stage: name,
						provider: activeModel.provider,
						model: activeModel.model,
						attempts: attempt + 1,
						ms: Math.round(performance.now() - t0),
						ok: false,
						obstacles,
					});
					this.log(`${name}: ${decision.strategy} - ${decision.rationale}`);
					return { output, model: activeModel };
			}
		}
	}

	/** Run the full pipeline for a build task. */
	async run(task: string): Promise<PipelineResult> {
		const t0 = performance.now();
		const ctx = new PipelineContext();
		ctx.task = task;
		ctx.design = designTokens();
		const records: StageRecord[] = [];
		const cfg = loadRoleConfig();

		// --- Stage 1: orchestrator plans ---
		const orchestrator = this.resolve("orchestrator", cfg.orchestrator);
		ctx.plan = (
			await this.runStage(
				"orchestrator",
				orchestrator,
				false,
				true,
				(m, budget, input) =>
					m.call(
						"You are the orchestrator. Produce a short numbered build plan. No code.",
						input,
						budget,
					),
				`${ctx.task}\n\nDesign tokens:\n${ctx.design}\n\nProduce a concise numbered build plan.`,
				records,
			)
		).output;
		await orchestrator.release();

		// --- Stage 2: context compaction (Apple Foundation, optional) ---
		ctx.brief = ctx.plan;
		const apple = this.roster.models.find((m) => m.provider === "apple-foundation");
		if (apple) {
			const compacted = await this.runStage(
				"context",
				apple,
				false,
				false, // optional: skip on failure, pipeline still proceeds
				(m, _budget, input) =>
					m.call(
						"Compress this into a tight engineer brief. Keep every requirement and token. No preamble.",
						input,
						512,
					),
				`Build plan:\n${ctx.plan.slice(0, 1200)}\n\nDesign tokens:\n${ctx.design.slice(0, 500)}`,
				records,
			);
			if (compacted.output.trim().length > 80) ctx.brief = compacted.output;
		}

		// --- Stage 3: engineer drafts ---
		const engineer = this.resolve("engineer", cfg.engineer);
		const drafted = await this.runStage(
			"engineer",
			engineer,
			true,
			true,
			(m, budget, input) =>
				m
					.call(
						"You are the engineer. Write complete, correct, runnable code. The file MUST end with </html>. Output only the file.",
						input,
						budget,
					)
					.then(extractHtml),
			`${ctx.task}\n\nDesign tokens:\n${ctx.design}\n\nEngineer brief:\n${ctx.brief || "(build from the requirements)"}`,
			records,
		);
		ctx.artifact = drafted.output;
		await drafted.model.release();

		// --- Adaptive repair loop ---
		// The engineer stage may have returned with a `repair` decision
		// pending (syntax error / quality defect). The repair loop applies
		// the strongest available intelligence: qa reviews, the strongest
		// model rewrites, re-check, repeat until clean or budget spent.
		let defects = staticChecks(ctx.artifact);
		const fixer = this.roster.strongest() ?? engineer;
		const qa = this.resolve("qa", cfg.qa);
		for (let pass = 1; defects.length > 0 && pass <= 3 && ctx.artifact; pass++) {
			this.log(`repair pass ${pass}: ${defects.length} defect(s)`);
			let review = "";
			try {
				review = await qa.call(
					"You are QA. List concrete defects and missing requirements only. Be specific.",
					`${ctx.task}\n\nSubmitted file:\n${ctx.artifact}`,
					1500,
				);
			} catch (err) {
				this.log(`repair pass ${pass}: qa failed (${err}) - using static defects only`);
			}
			const brief = [review, "Automated render checks (MUST fix):", ...defects].join("\n");
			let fixed = "";
			try {
				fixed = extractHtml(
					await fixer.call(
						"You are the engineer. Apply every fix. Output the COMPLETE corrected file, ending with </html>. Output only the file.",
						`${ctx.task}\n\nCurrent file:\n${ctx.artifact}\n\nDefects to fix:\n${brief}`,
						16000,
					),
				);
			} catch (err) {
				this.log(`repair pass ${pass}: fixer failed (${err})`);
				break;
			}
			const fixedDefects = staticChecks(fixed);
			if (fixed.length > ctx.artifact.length * 0.6 && fixedDefects.length < defects.length) {
				ctx.artifact = fixed;
				defects = fixedDefects;
				records.push({
					stage: `repair-${pass}`,
					provider: fixer.provider,
					model: fixer.model,
					attempts: 1,
					ms: 0,
					ok: fixedDefects.length === 0,
					obstacles: fixedDefects,
				});
				this.log(`repair pass ${pass}: accepted (${defects.length} remain)`);
			} else {
				this.log(`repair pass ${pass}: rejected - keeping previous artifact`);
				break;
			}
		}

		return {
			artifact: ctx.artifact,
			ok: ctx.artifact.length > 400 && defects.length === 0,
			defects,
			stages: records,
			totalMs: Math.round(performance.now() - t0),
		};
	}
}

/** Convenience wrapper: detect the roster and run one task. */
export async function runAdaptivePipeline(opts: PipelineOptions): Promise<PipelineResult> {
	const pipeline = await AdaptivePipeline.create(opts);
	return pipeline.run(opts.task);
}

// ======================================================================
// Low-level helpers (model transports, artifact checks, design tokens)
// ======================================================================

async function callOllama(model: string, system: string, user: string, numPredict: number) {
	const res = await fetch(`${OLLAMA_URL}/api/chat`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			stream: false,
			think: false,
			options: { temperature: 0.4, num_predict: numPredict },
		}),
		signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 160)}`);
	const json = (await res.json()) as { message?: { content?: string } };
	return json.message?.content ?? "";
}

async function callLMStudio(model: string, system: string, user: string, maxTokens: number) {
	const res = await fetch(`${LMSTUDIO_URL}/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			temperature: 0.4,
			max_tokens: maxTokens,
		}),
		signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`lmstudio ${res.status}: ${(await res.text()).slice(0, 160)}`);
	const json = (await res.json()) as {
		choices?: { message?: { content?: string; reasoning_content?: string } }[];
	};
	const msg = json.choices?.[0]?.message;
	return msg?.content || msg?.reasoning_content || "";
}

function callAppleFoundation(system: string, user: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn(BRIDGE_PATH, [], { stdio: ["pipe", "pipe", "ignore"] });
		let buf = "";
		const timer = setTimeout(() => {
			proc.kill();
			reject(new Error("apple-foundation bridge timed out"));
		}, 120_000);
		proc.stdout.on("data", (c) => {
			buf += c;
			const nl = buf.indexOf("\n");
			if (nl === -1) return;
			clearTimeout(timer);
			proc.kill();
			try {
				const r = JSON.parse(buf.slice(0, nl)) as {
					message?: { content?: string };
					error?: string;
				};
				if (r.error) reject(new Error(`apple-foundation: ${r.error}`));
				else resolve(r.message?.content ?? "");
			} catch (err) {
				reject(new Error(`apple-foundation bad JSON: ${err}`));
			}
		});
		proc.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		proc.stdin.write(
			`${JSON.stringify({
				model: "apple-foundationmodel",
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
			})}\n`,
		);
	});
}

async function unloadOllama(model: string): Promise<void> {
	try {
		await fetch(`${OLLAMA_URL}/api/generate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model, keep_alive: 0 }),
			signal: AbortSignal.timeout(5000),
		});
	} catch {
		/* best effort */
	}
}

function extractHtml(text: string): string {
	const fence = text.match(/```(?:html)?\s*\n([\s\S]*?)```/);
	const body = fence ? fence[1] : text;
	const start = body.search(/<!doctype html|<html/i);
	return (start >= 0 ? body.slice(start) : body).trim();
}

/**
 * Functional render-readiness gate. Catches truncation, a dead render
 * loop, and - via the Bun transpiler - any JavaScript that will not parse.
 */
export function staticChecks(html: string): string[] {
	const d: string[] = [];
	if (!/<\/html>\s*$/i.test(html.trim()))
		d.push("File is TRUNCATED - it must end with </html>. Output the COMPLETE file.");
	if (!/requestAnimationFrame/.test(html)) d.push("No requestAnimationFrame loop.");
	const transpiler = new Bun.Transpiler({ loader: "ts" });
	for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
		const code = m[1]?.trim();
		if (!code) continue;
		try {
			transpiler.transformSync(code);
		} catch (err) {
			d.push(
				`JavaScript SYNTAX ERROR - the page will not run: ${String(err).replace(/\s+/g, " ").slice(0, 150)}`,
			);
		}
	}
	return d;
}

function designTokens(): string {
	const candidates = [
		join(process.cwd(), "data", "design-systems.db"),
		join(homedir(), ".8gent", "design-systems.db"),
	];
	const dbPath = candidates.find((p) => existsSync(p));
	if (!dbPath) return "(no design-system DB found - choose tasteful defaults)";
	try {
		const db = new Database(dbPath);
		const sys = db
			.query(
				"SELECT id, name FROM design_systems WHERE style IN ('minimal','elegant','tech') LIMIT 1",
			)
			.get() as { id: string; name: string } | null;
		if (!sys) {
			db.close();
			return "(design DB empty)";
		}
		const pal = db
			.query("SELECT * FROM color_palettes WHERE system_id = ?")
			.get(sys.id) as Record<string, string> | null;
		const typo = db
			.query("SELECT * FROM typography WHERE system_id = ?")
			.get(sys.id) as Record<string, string> | null;
		db.close();
		const lines = [`Design system: ${sys.name} (inbuilt design DB)`];
		if (pal)
			for (const k of ["accent_hsl", "primary_hsl", "muted_foreground_hsl", "border_hsl"])
				if (pal[k]) lines.push(`  --${k.replace("_hsl", "")}: hsl(${pal[k]})`);
		if (typo) lines.push(`Typography: ${typo.font_family}`);
		return lines.join("\n");
	} catch (err) {
		return `(design DB unavailable: ${err})`;
	}
}
