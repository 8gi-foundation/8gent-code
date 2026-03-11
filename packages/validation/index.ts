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
