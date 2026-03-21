/**
 * 8gent Code - Validation Package
 *
 * Exports all validation-related functionality including
 * evidence collection and report generation.
 */

export {
  EvidenceCollector,
  formatEvidence,
  summarizeEvidence,
  filterEvidence,
  isEvidenceSufficient,
  type Evidence,
  type EvidenceType,
  type EvidenceCollectorConfig,
  type StepExecutionResult,
} from "./evidence";

export {
  ValidationReporter,
  getValidationReporter,
  type ValidationReport,
  type StepReport,
  type ReportDisplayOptions,
} from "./report";

export {
  SelfHealer,
  type VerifyCheck,
  type VerifyResult,
  type HealingResult,
  type SelfHealerOptions,
} from "./healing";

export {
  createCheckpoint,
  restoreCheckpoint,
  dropCheckpoint,
  type Checkpoint,
} from "./checkpoint";

export {
  logFailure,
  readFailures,
  findPriorFailure,
  type FailureEntry,
} from "./failure-log";

export {
  scanFile,
  scanDirectory,
  scanContent,
  summarizeFindings,
  hasCriticalFindings,
  type SecurityFinding,
  type ScanOptions,
  type ScanSummary,
} from "./security-scanner";

export { SECRET_PATTERNS, VULNERABILITY_PATTERNS } from "./secret-patterns";

export {
  AbilityScorecardTracker,
  ABILITIES,
  ABILITY_METRIC_DESCRIPTIONS,
  type AbilityScorecard,
  type AbilityMetric,
  type AbilityName,
  type BaselineDelta,
} from "./ability-scorecard";
