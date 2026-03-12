/**
 * 8gent Code - Workflow Package
 *
 * Exports all workflow-related functionality including
 * the Plan-Validate Loop and Proactive-Infinite systems.
 */

export {
  PlanValidateLoop,
  PlanBuilder,
  parsePlanFromResponse,
  formatPlan,
  type Step,
  type StepStatus,
  type ToolCallRecord,
  type PlanValidateConfig,
  type ExecutionOptions,
  type ValidationResult,
} from "./plan-validate";

// Proactive questioning + Infinite mode workflow
export {
  ProactiveInfiniteWorkflow,
  createWorkflow,
  runWorkflow,
  PROACTIVE_SYSTEM_ADDITION,
  INFINITE_OFFER_PROMPT,
  type WorkflowPhase,
  type WorkflowState,
  type WorkflowConfig,
  type WorkflowEvent,
} from "./proactive-infinite";

// Re-export Evidence type for convenience
export type { Evidence } from "../validation/evidence";

// BMAD Process Integration
export {
  KanbanBoard,
  getKanbanBoard,
  resetKanbanBoard,
  classifyTaskSize,
  generateAcceptanceCriteria,
  decomposeTask,
  type BMadTask,
  type BMadTaskSize,
  type BMadStatus,
  type BMadStep,
  type BMadBoard,
  type BMadColumn,
  type AcceptanceCriterion,
} from "./bmad-process";

// Git Workflow Integration
export {
  GitWorkflowManager,
  getGitWorkflow,
  resetGitWorkflow,
  inferCommitType,
  inferScope,
  generateCommitMessage,
  parseCommitMessage,
  generateBranchName,
  inferBranchPrefix,
  validateBranchName,
  generatePRDescription,
  formatPRDescription,
  type CommitType,
  type ConventionalCommit,
  type BranchConfig,
  type PRDescription,
} from "./git-workflow";
