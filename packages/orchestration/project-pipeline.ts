/**
 * project-pipeline.ts - the MoA build loop.
 *
 * Generalises the single-file AdaptivePipeline into a multi-file project build
 * that lets weak local models actually finish real work, by combining five
 * capabilities around the pipeline's existing deterministic brain
 * (DecisionPalette + Obstacle/Severity):
 *
 *   scaffold  - the harness GIVES the structure (config/layout/tokens)
 *   decompose - a thinker model splits the task into one-file units
 *   execute   - an AGENT node (ornith) runs its OWN tool loop per unit
 *   verify    - real gates (file exists, compiles) become Obstacles
 *   escalate  - on a Severe obstacle, hand the unit to a stronger executor
 *
 * Completion models think (decompose); the agent node acts (execute). The
 * outer loop stays deterministic and replayable; the agent's nondeterminism is
 * sealed inside a single unit and judged by deterministic verifiers. Every step
 * emits a structured event so Flow can watch and steer.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DecisionPalette, Model, ModelRoster, Obstacle, ObstacleType, Severity } from "./adaptive-pipeline.js";
import { createAgentNode } from "./agent-node.js";
import { decompose, type ThinkerCall } from "./decompose.js";
import type { BuildUnit, ExecutorNode, VerifierFinding } from "./pipeline-contracts.js";
import { PipelineEventBus } from "./pipeline-events.js";
import { getScaffold } from "./scaffold.js";
import { fileExistsVerifier, tscVerifier } from "./verifiers.js";

/** Map a verifier finding into the pipeline's native Obstacle vocabulary. */
function findingToObstacle(f: VerifierFinding): Obstacle {
	const severity =
		f.severity === "severe" ? Severity.Severe : f.severity === "moderate" ? Severity.Moderate : Severity.Trivial;
	const type =
		f.type === "compile-error"
			? ObstacleType.SyntaxError
			: f.type === "compile-timeout"
				? ObstacleType.Timeout
				: f.type === "missing-file"
					? ObstacleType.EmptyOutput
					: ObstacleType.QualityDefect;
	return new Obstacle(type, severity, f.detail);
}

// Agentic-executor preference: ornith natively tool-calls (the strongest
// executor); coder/agent models are next; everything else ranks by raw score.
// This is the fix for "score by size sidelines the best agent" - a 9B agent
// that can ACT beats a 27B completion that can only emit text, for execution.
function executorTier(modelId: string): number {
	if (/ornith/i.test(modelId)) return 2;
	if (/coder|agent|deepseek/i.test(modelId)) return 1;
	return 0;
}

/** Rank tool-capable local models as agent executors (strongest first). */
export function rankExecutors(models: Model[]): Model[] {
	return models
		.filter((m) => m.provider === "lmstudio")
		.sort((a, b) => {
			const t = executorTier(b.model) - executorTier(a.model);
			return t !== 0 ? t : b.score - a.score;
		});
}

export interface ProjectPipelineOptions {
	task: string;
	workingDirectory: string;
	projectType?: string;
	maxAttempts?: number;
	/** Optional Flow relay URL; pipeline events are POSTed here as they happen. */
	httpSink?: string;
	onProgress?: (line: string) => void;
}

export interface UnitOutcome {
	id: string;
	path: string;
	ok: boolean;
	model: string;
	attempts: number;
}

export interface ProjectResult {
	ok: boolean;
	workingDirectory: string;
	projectType: string;
	unitsPlanned: number;
	filesWritten: string[];
	units: UnitOutcome[];
	compileOk: boolean;
	compileDetail: string;
}

export class ProjectPipeline {
	private readonly palette: DecisionPalette;
	private readonly bus: PipelineEventBus;
	private readonly maxAttempts: number;
	private readonly workdir: string;
	private readonly projectType: string;

	constructor(
		private readonly task: string,
		private readonly thinker: Model,
		private readonly executors: ExecutorNode[],
		opts: ProjectPipelineOptions,
	) {
		this.workdir = opts.workingDirectory;
		this.projectType = opts.projectType ?? "next-app";
		this.maxAttempts = opts.maxAttempts ?? 3;
		this.palette = new DecisionPalette(this.maxAttempts);
		this.bus = new PipelineEventBus({ httpSink: opts.httpSink, onLine: opts.onProgress });
	}

	/** Detect the roster and assign thinker (strongest completion) + agent executors. */
	static async create(opts: ProjectPipelineOptions): Promise<ProjectPipeline> {
		const roster = await ModelRoster.detect();
		const thinker = roster.strongest() ?? new Model("lmstudio", "unknown", 0);
		const ranked = rankExecutors(roster.models);
		const executors = (ranked.length > 0 ? ranked : [thinker]).map((m) =>
			createAgentNode({ provider: m.provider, model: m.model }),
		);
		return new ProjectPipeline(opts.task, thinker, executors, opts);
	}

	subscribe(sink: Parameters<PipelineEventBus["subscribe"]>[0]) {
		return this.bus.subscribe(sink);
	}

	async run(): Promise<ProjectResult> {
		fs.mkdirSync(this.workdir, { recursive: true });

		// --- 1. Scaffold: hand the model the structure up front ---
		this.bus.emit({ kind: "stage", stage: "scaffold", status: "start", detail: this.projectType });
		const scaffold = getScaffold(this.projectType);
		for (const file of scaffold.files) {
			const abs = path.join(this.workdir, file.path);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, file.content);
		}
		this.bus.emit({ kind: "stage", stage: "scaffold", status: "clear", detail: `${scaffold.files.length} files` });

		// --- 2. Decompose: a thinker splits the task into one-file units ---
		this.bus.emit({ kind: "stage", stage: "decompose", status: "start", model: this.thinker.key });
		const thinkerCall: ThinkerCall = (system, user) => this.thinker.call(system, user, 2000);
		const plan = await decompose({
			task: this.task,
			projectType: this.projectType,
			structureNote: scaffold.structureNote,
			call: thinkerCall,
		});
		this.bus.emit({ kind: "stage", stage: "decompose", status: "clear", detail: `${plan.units.length} units` });

		// --- 3. Execute each unit through the agent + verify + escalate loop ---
		const units: UnitOutcome[] = [];
		for (const unit of plan.units) {
			units.push(await this.buildUnit(unit, scaffold.structureNote));
		}

		// --- 4. Final verifier: does the whole project compile? ---
		const compile = await tscVerifier.verify({ workingDirectory: this.workdir });
		if (!compile.ok) {
			this.bus.emit({ kind: "obstacle", stage: "verify", obstacle: compile.type, severity: compile.severity });
		}

		const filesWritten = units.filter((u) => u.ok).map((u) => u.path);
		const ok = units.length > 0 && units.every((u) => u.ok);
		this.bus.emit({ kind: "done", ok, artifact: this.workdir });

		return {
			ok,
			workingDirectory: this.workdir,
			projectType: this.projectType,
			unitsPlanned: plan.units.length,
			filesWritten,
			units,
			compileOk: compile.ok,
			compileDetail: compile.detail,
		};
	}

	/** Build one unit: execute, verify it landed, escalate to a stronger executor on failure. */
	private async buildUnit(unit: BuildUnit, structureNote: string): Promise<UnitOutcome> {
		const context = [structureNote, this.dependencyContext(unit)].filter(Boolean).join("\n\n");
		const goal =
			`Create the file \`${unit.path}\`.\n\n${unit.spec}\n\n` +
			`Write the complete file using the write_file tool. Do not describe it - write it.`;

		let execIdx = 0;
		let budget = 6000;

		for (let attempt = 0; ; attempt++) {
			const node = this.executors[Math.min(execIdx, this.executors.length - 1)];
			this.bus.emit({ kind: "unit", unitId: unit.id, path: unit.path, status: "start", model: node.key });

			let res = { ok: false, filesWritten: [] as string[], transcript: "", error: undefined as string | undefined };
			try {
				res = await node.run({ goal, workingDirectory: this.workdir, budgetTokens: budget, context });
			} catch (err) {
				res.error = String(err);
			}

			const finding = await fileExistsVerifier.verify({ workingDirectory: this.workdir, unit });
			if (finding.ok) {
				this.bus.emit({ kind: "unit", unitId: unit.id, path: unit.path, status: "done", model: node.key });
				return { id: unit.id, path: unit.path, ok: true, model: node.key, attempts: attempt + 1 };
			}

			const obstacle = res.error
				? new Obstacle(ObstacleType.ProviderUnhealthy, Severity.Severe, res.error.slice(0, 160))
				: findingToObstacle(finding);
			this.bus.emit({ kind: "obstacle", stage: unit.id, obstacle: obstacle.type, severity: String(obstacle.severity) });

			const decision = this.palette.decide(obstacle, attempt, true);
			this.bus.emit({ kind: "decision", stage: unit.id, strategy: decision.strategy, rationale: decision.rationale });

			if (decision.strategy === "abort" || decision.strategy === "skip") {
				this.bus.emit({ kind: "unit", unitId: unit.id, path: unit.path, status: "failed", model: node.key });
				return { id: unit.id, path: unit.path, ok: false, model: node.key, attempts: attempt + 1 };
			}
			if (decision.strategy === "escalate" || decision.strategy === "reassign") {
				if (execIdx < this.executors.length - 1) {
					const next = this.executors[execIdx + 1];
					this.bus.emit({ kind: "escalate", from: node.key, to: next.key, reason: decision.rationale });
					execIdx++;
				}
			}
			if (decision.strategy === "raise-budget") budget = Math.min(budget * 2, 16000);
		}
	}

	/** Read short excerpts of a unit's already-built dependencies, for grounding. */
	private dependencyContext(unit: BuildUnit): string {
		const parts: string[] = [];
		for (const depPath of unit.dependsOn) {
			const abs = path.join(this.workdir, depPath);
			try {
				if (fs.existsSync(abs)) {
					parts.push(`// ${depPath}\n${fs.readFileSync(abs, "utf8").slice(0, 600)}`);
				}
			} catch {
				// best-effort grounding
			}
		}
		return parts.length ? `Already-built files you can rely on:\n${parts.join("\n\n")}` : "";
	}
}
