/**
 * IncrementalContextCompressor — orchestrates compression for a single session.
 *
 * Issue #2420. Wraps the existing `ProactiveCompression` (token-pressure 4-stage
 * pipeline) and adds:
 *
 *   1. Milestone-based triggers — compress at natural breakpoints (file written,
 *      test passed, task complete) rather than only when token pressure hits.
 *      Compressing at semantic boundaries yields cleaner summaries than
 *      compressing mid-thought at arbitrary token offsets.
 *
 *   2. Artifact registry — file paths, decisions, code snippets, errors, and
 *      commands live outside the compressible message history. Every compression
 *      pass re-injects the registry into the surviving system message so the
 *      agent never loses track of what it has touched.
 *
 *   3. Per-session-type config — interactive chat, long-running task, telegram
 *      bot, and computer-use sessions have very different cadences. Each gets
 *      its own preset (registry caps, milestone gating, compression aggressiveness).
 *
 *   4. Metrics — compression ratio, artifact retention, reference retention.
 *      Emitted to JSONL for offline golden-set evaluation.
 *
 * The internal `ProactiveCompression` engine keeps its own `previousSummary`
 * (Facto-style incremental summarization) so each summary builds on the prior
 * one rather than regenerating from raw history.
 */

import type { LanguageModel } from "ai";
import {
	type CompactionConfig,
	type CompressionStage,
	DEFAULT_PROACTIVE_CONFIG,
	ProactiveCompression,
	type ProactiveResult,
} from "../compaction";
import {
	ArtifactRegistry,
	type ArtifactRegistryConfig,
	DEFAULT_REGISTRY_CONFIG,
} from "./artifact-registry";
import {
	type CompressionMetric,
	CompressionMetrics,
	type CompressionTrigger,
	extractPaths,
	intersectionRatio,
} from "./metrics";
import { type Milestone, MilestoneDetector } from "./milestone-detector";

export type SessionType = "interactive" | "long_running" | "telegram" | "computer";

export interface IncrementalCompressorConfig {
	sessionType: SessionType;
	/** Pass-through to the underlying ProactiveCompression. */
	compaction: Partial<CompactionConfig> & { threshold?: number };
	registry: Partial<ArtifactRegistryConfig>;
	milestone: {
		/** Min messages added since last compression before milestone-trigger fires. */
		minMessagesSinceLast: number;
		/** Min total estimated tokens before milestone-trigger fires. */
		minTokensSinceLast: number;
		/** Milestone confidence floor. */
		minConfidence: number;
	};
	/** Optional file path for JSONL metrics emission. */
	metricsLogFile?: string | null;
}

const PRESETS: Record<SessionType, IncrementalCompressorConfig> = {
	interactive: {
		sessionType: "interactive",
		compaction: { ...DEFAULT_PROACTIVE_CONFIG, threshold: 0.3 },
		registry: { ...DEFAULT_REGISTRY_CONFIG },
		milestone: { minMessagesSinceLast: 12, minTokensSinceLast: 4000, minConfidence: 0.85 },
		metricsLogFile: null,
	},
	long_running: {
		sessionType: "long_running",
		compaction: { ...DEFAULT_PROACTIVE_CONFIG, threshold: 0.35, keepRecentTokens: 12000 },
		registry: { ...DEFAULT_REGISTRY_CONFIG, maxRenderChars: 4500 },
		milestone: { minMessagesSinceLast: 8, minTokensSinceLast: 2500, minConfidence: 0.8 },
		metricsLogFile: null,
	},
	telegram: {
		sessionType: "telegram",
		compaction: { ...DEFAULT_PROACTIVE_CONFIG, threshold: 0.4, keepRecentTokens: 6000 },
		registry: { ...DEFAULT_REGISTRY_CONFIG, maxRenderChars: 1800 },
		milestone: { minMessagesSinceLast: 6, minTokensSinceLast: 1500, minConfidence: 0.75 },
		metricsLogFile: null,
	},
	computer: {
		sessionType: "computer",
		compaction: { ...DEFAULT_PROACTIVE_CONFIG, threshold: 0.35, keepRecentTokens: 8000 },
		registry: { ...DEFAULT_REGISTRY_CONFIG, maxRenderChars: 2500 },
		milestone: { minMessagesSinceLast: 6, minTokensSinceLast: 2000, minConfidence: 0.8 },
		metricsLogFile: null,
	},
};

export function presetFor(sessionType: SessionType): IncrementalCompressorConfig {
	// Deep clone so caller mutations don't leak into the shared preset.
	const p = PRESETS[sessionType];
	return {
		sessionType: p.sessionType,
		compaction: { ...p.compaction },
		registry: { ...p.registry },
		milestone: { ...p.milestone },
		metricsLogFile: p.metricsLogFile ?? null,
	};
}

type Message = { role: string; content: string };

const REGISTRY_MARKER = "[Artifact Registry]";

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function estimateMessageTokens(messages: Message[]): number {
	let total = 0;
	for (const m of messages) total += estimateTokens(m.content) + 4;
	return total;
}

export class IncrementalContextCompressor {
	readonly registry: ArtifactRegistry;
	readonly metrics: CompressionMetrics;
	readonly detector = new MilestoneDetector();

	private engine: ProactiveCompression;
	private config: IncrementalCompressorConfig;
	private sessionId: string;

	private messagesAtLastCompression = 0;
	private tokensAtLastCompression = 0;
	private pendingMilestones: Milestone[] = [];

	constructor(sessionId: string, config: Partial<IncrementalCompressorConfig> = {}) {
		this.sessionId = sessionId;
		const base = presetFor(config.sessionType ?? "interactive");
		this.config = {
			...base,
			...config,
			compaction: { ...base.compaction, ...(config.compaction ?? {}) },
			registry: { ...base.registry, ...(config.registry ?? {}) },
			milestone: { ...base.milestone, ...(config.milestone ?? {}) },
			metricsLogFile: config.metricsLogFile ?? base.metricsLogFile,
		};
		this.engine = new ProactiveCompression(this.config.compaction);
		this.registry = new ArtifactRegistry(this.config.registry);
		this.metrics = new CompressionMetrics(this.config.metricsLogFile);
	}

	/**
	 * Notify the compressor of a tool-call result. The detector decides whether
	 * it's a milestone; the registry records artifacts unconditionally.
	 */
	noteToolCall(call: {
		name: string;
		args?: Record<string, unknown>;
		resultPreview?: string;
		success?: boolean;
	}): void {
		// Always record artifacts — registry is never compressed.
		const path =
			(call.args?.file_path as string | undefined) ??
			(call.args?.path as string | undefined) ??
			(call.args?.filePath as string | undefined);
		if (path && (call.name === "Read" || call.name === "read_file")) {
			this.registry.add("file", path, "(read)");
		}
		if (
			path &&
			(call.name === "Write" ||
				call.name === "write_file" ||
				call.name === "Edit" ||
				call.name === "edit_file")
		) {
			this.registry.add("file", path, call.success === false ? "(write failed)" : "(written)");
		}
		if (call.name === "Bash" || call.name === "bash") {
			const cmd = (call.args?.command as string | undefined) ?? "";
			if (cmd)
				this.registry.add("command", cmd.slice(0, 80), call.resultPreview?.slice(0, 200) ?? "");
		}
		if (call.success === false && call.resultPreview) {
			this.registry.add("error", call.name, call.resultPreview.slice(0, 200));
		}

		const milestone = this.detector.fromToolCall(call);
		if (milestone && milestone.confidence >= this.config.milestone.minConfidence) {
			this.pendingMilestones.push(milestone);
		}
	}

	/**
	 * Notify the compressor of an assistant text message. Catches free-text
	 * milestones (decisions, "task complete") that don't surface via tool calls.
	 */
	noteAssistantText(text: string): void {
		const milestones = this.detector.fromAssistantText(text);
		for (const m of milestones) {
			if (m.kind === "decision_recorded") {
				this.registry.add("decision", `d_${this.registry.size("decision") + 1}`, m.signal);
			}
			if (m.confidence >= this.config.milestone.minConfidence) {
				this.pendingMilestones.push(m);
			}
		}
	}

	/**
	 * Decide whether to compress now. Returns the trigger reason or null.
	 *
	 *  - `token_pressure` if the underlying engine says we're over threshold.
	 *  - `milestone` if a pending milestone fires AND the conversation has
	 *    grown enough since the last compression to make it worthwhile.
	 */
	decideTrigger(messages: Message[], contextWindow?: number): CompressionTrigger | null {
		if (this.engine.shouldCompact(messages, contextWindow)) {
			return "token_pressure";
		}
		if (this.pendingMilestones.length === 0) return null;
		const messagesSince = messages.length - this.messagesAtLastCompression;
		const currentTokens = estimateMessageTokens(messages);
		const tokensSince = currentTokens - this.tokensAtLastCompression;
		if (
			messagesSince >= this.config.milestone.minMessagesSinceLast &&
			tokensSince >= this.config.milestone.minTokensSinceLast
		) {
			return "milestone";
		}
		return null;
	}

	/**
	 * Compress the message history. Returns the new history with the artifact
	 * registry block re-injected into the system message slot. Records a metric.
	 */
	async compress(
		messages: Message[],
		model: LanguageModel,
		opts: { trigger?: CompressionTrigger; contextWindow?: number } = {},
	): Promise<{ messages: Message[]; result: ProactiveResult; trigger: CompressionTrigger }> {
		const trigger = opts.trigger ?? this.decideTrigger(messages, opts.contextWindow) ?? "manual";
		const startMs = Date.now();
		const tokensBefore = estimateMessageTokens(messages);
		const artifactsBefore = this.registry.size();

		// Pull pre-compression file references for the retention proxy.
		const preRefs = new Set<string>();
		for (const m of messages) for (const p of extractPaths(m.content)) preRefs.add(p);

		const { messages: compacted, result } = await this.engine.compactProactive(
			messages,
			model,
			opts.contextWindow,
		);

		const withRegistry = this.injectRegistry(compacted);
		const tokensAfter = estimateMessageTokens(withRegistry);
		const artifactsAfter = this.registry.size();

		// Compute retention proxies. Registry artifacts are 1.0 by construction.
		const postRefs = new Set<string>();
		for (const m of withRegistry) for (const p of extractPaths(m.content)) postRefs.add(p);
		const referenceRetention = intersectionRatio(preRefs, postRefs);
		const artifactRetention = artifactsBefore === 0 ? 1 : artifactsAfter / artifactsBefore;

		const metric: CompressionMetric = {
			at: Date.now(),
			sessionId: this.sessionId,
			trigger,
			stage: result.stage,
			tokensBefore,
			tokensAfter,
			compressionRatio: tokensBefore === 0 ? 1 : tokensAfter / tokensBefore,
			messagesRemoved: result.messagesRemoved,
			artifactsBefore,
			artifactsAfter,
			artifactRetention,
			referenceRetention,
			durationMs: Date.now() - startMs,
		};
		this.metrics.record(metric);

		this.messagesAtLastCompression = withRegistry.length;
		this.tokensAtLastCompression = tokensAfter;
		this.pendingMilestones = [];

		return { messages: withRegistry, result, trigger };
	}

	/**
	 * Inject the artifact registry block into the system message slot. If a
	 * previous registry block exists (marker present), it's replaced; otherwise
	 * a new system message is appended right after the root system prompt.
	 */
	private injectRegistry(messages: Message[]): Message[] {
		const block = this.registry.render();
		if (!block) return messages;
		const tagged = `${REGISTRY_MARKER}\n${block}`;

		// Find an existing registry message and replace it.
		const idx = messages.findIndex(
			(m) => m.role === "system" && m.content.startsWith(REGISTRY_MARKER),
		);
		if (idx >= 0) {
			const next = messages.slice();
			next[idx] = { role: "system", content: tagged };
			return next;
		}

		// Otherwise insert right after the root system prompt (index 0). The
		// existing CompactionEngine inserts a `[Context Compaction Summary]`
		// message at index 1; we put the registry at index 1 too, before the
		// summary, so the agent sees artifacts first.
		if (messages.length === 0) return [{ role: "system", content: tagged }];
		const root = messages[0];
		const rest = messages.slice(1);
		return [root, { role: "system", content: tagged }, ...rest];
	}

	/** Test hook + ops endpoint. */
	getConfig(): Readonly<IncrementalCompressorConfig> {
		return this.config;
	}
}
