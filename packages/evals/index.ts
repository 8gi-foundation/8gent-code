// @8gent/evals — golden test sets + measurement baselines.
// Issue #2421.

export * from "./types.js";
export {
	createOpenRouterExecutor,
	createMockExecutor,
	selectExecutor,
} from "./executor.js";
export { scoreCase, type ScorerOptions } from "./scorer.js";
export {
	runEvals,
	loadGoldenSet,
	writeReport,
	latencyStats,
	type RunnerOptions,
} from "./runner.js";
export {
	reportToSnapshot,
	loadBaseline,
	writeBaseline,
	compare,
	formatRegressions,
	SCORE_REGRESSION_THRESHOLD,
	LATENCY_REGRESSION_RATIO,
} from "./baseline.js";
