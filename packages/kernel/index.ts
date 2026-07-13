/**
 * @8gent/kernel — Continuous RL Fine-Tuning Pipeline
 *
 * Manages the full lifecycle of model improvement:
 *   Phase 1: Proxy management (start/stop training proxy, latency monitoring)
 *   Phase 2: Judge scoring (PRM wiring, score distribution tracking)
 *   Phase 3: Training orchestration (GRPO trigger, checkpoint validation)
 *   Phase 4: Production loop (MadMax scheduling, regression gates, auto-promotion)
 */

export { TrainingProxy, type ProxyConfig, type ProxyStatus } from "./proxy";
export { JudgeScorer, type JudgeConfig, type ScoreRecord } from "./judge";
export {
	TrainingOrchestrator,
	type TrainingConfig,
	type CheckpointInfo,
} from "./training";
export { ProductionLoop, type ProductionConfig, type LoopStatus } from "./loop";
export { KernelManager, type KernelConfig } from "./manager";
export {
	LocalTrainer,
	checkTrainerDeps,
	type LocalTrainerConfig,
} from "./local-trainer";
export {
	HedgeExecutor,
	DEFAULT_HEDGE_CONFIG,
	selectCandidates,
	type HedgeConfig,
	type HedgeCandidate,
	type HedgeGenerator,
	type HedgeRunOptions,
	type HedgeRunResult,
	type HedgeSignalRow,
	type GenerateResult,
} from "./hedge-executor";
export {
	ResourceGovernor,
	decide as decideResourceVerdict,
	turnCostUsd,
	DEFAULT_BUDGET_POLICY,
	type GovernorVerdict,
	type ResourceSnapshot,
	type BudgetPolicy,
	type Vitals,
	type ThermalState,
} from "./resource-governor";
export {
	evaluatePromotion,
	holdOutBeats,
	loadPromotionPolicy,
	writeRollbackManifest,
	readRollbackManifest,
	DEFAULT_PROMOTION_POLICY,
	PROMOTION_POLICY_PATH,
	type PromotionPolicy,
	type PromotionRequest,
	type PromotionDecision,
	type PromotionAutonomy,
	type HoldOut,
	type HoldOutResult,
	type CanarySignal,
	type HumanConfirm,
	type RollbackManifest,
	type BumpClass,
} from "./promotion-gate";
export {
	exportDailyCorpus,
	DEFAULT_BDH_CORPUS_DIR,
	type BdhExportOptions,
	type BdhExportResult,
	type BdhCorpusRow,
} from "./bdh-export";
export {
	TraceCapture,
	type ToolStep,
	type Trajectory,
	type FinalizeTurnInput,
} from "./trace-capture";
export {
	LessonCollector,
	parseLiveDemoLedger,
	parseSelfHealReport,
	liveDemoToLessons,
	selfHealToLessons,
	lessonsToGrpoPairs,
	type LiveDemoEntry,
	type SelfHealFinding,
	type LessonExample,
	type LessonSources,
	type CollectResult,
} from "./lesson-collector";
