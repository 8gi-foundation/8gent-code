/**
 * 8gent Code - Prompts Package
 *
 * Exports all prompt-related functionality for context engineering
 * and efficient token usage.
 */

export {
  // Prompt Segments (composable)
  IDENTITY_SEGMENT,
  ARCHITECTURE_SEGMENT,
  BMAD_SEGMENT,
  TOOL_PATTERNS_SEGMENT,
  ERROR_RECOVERY_SEGMENT,
  THINKING_PATTERNS_SEGMENT,
  COMPLETION_SEGMENT,
  RULES_SEGMENT,

  // Composed Prompts
  FULL_SYSTEM_PROMPT,
  SUBAGENT_SYSTEM_PROMPT,
  PLANNING_PROMPT,
  VALIDATION_PROMPT,

  // Context Engineering Functions
  compressContext,
  buildContextualPrompt,
  getTaskSpecificPrompt,
} from "./system-prompt";
