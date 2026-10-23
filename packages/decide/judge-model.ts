/**
 * The calibrated System One judge, named once.
 *
 * The name is read from the calibration file the judge's thresholds were fitted
 * on (calibration/ollama-<model>.json, `model` field), so there is no second
 * model literal in product code (scripts/model-literals.ts) and the name is
 * fixed at build time: a static import is bundled, never read from user config
 * or the environment. Used by the one-yes installer (packages/eight/judge-install.ts).
 */
import calibration from "./calibration/ollama-hf.co_AtlaAI_Selene-1-Mini-Llama-3.1-8B-Q4_K_M-GGUF_latest.json";

export const JUDGE_MODEL: string = calibration.model;
