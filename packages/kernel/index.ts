/**
 * @8gent/kernel — Continuous RL Fine-Tuning via MetaClaw
 *
 * Manages the full lifecycle of model improvement:
 *   Phase 1: Proxy management (start/stop MetaClaw, latency monitoring)
 *   Phase 2: Judge scoring (PRM wiring, score distribution tracking)
 *   Phase 3: Training orchestration (GRPO trigger, checkpoint validation)
 *   Phase 4: Production loop (MadMax scheduling, regression gates, auto-promotion)
 */

export { MetaClawProxy, type ProxyConfig, type ProxyStatus } from "./proxy";
export { JudgeScorer, type JudgeConfig, type ScoreRecord } from "./judge";
export { TrainingOrchestrator, type TrainingConfig, type CheckpointInfo } from "./training";
export { ProductionLoop, type ProductionConfig, type LoopStatus } from "./loop";
export { KernelManager, type KernelConfig } from "./manager";
export { LocalTrainer, checkTrainerDeps, type LocalTrainerConfig } from "./local-trainer";
