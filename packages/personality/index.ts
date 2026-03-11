/**
 * 8gent Code - Personality Package
 *
 * The infinite gentleman agent coder - refined, witty,
 * confident, endlessly capable.
 *
 * This package provides:
 * - Animated status verbs that cycle during processing
 * - Personality voice for response flavoring
 * - Brand identity and visual assets
 */

// Status Verbs - Animated cycling during processing
export {
  THINKING_VERBS,
  EXECUTING_VERBS,
  PLANNING_VERBS,
  StatusVerbs,
  statusVerbs,
  getRandomVerb,
  getVerbsForType,
  getNextVerb,
  type StatusVerbType,
} from "./status-verbs.js";

// Personality Voice - Response flavoring
export {
  PERSONALITY,
  GREETINGS,
  COMPLETION_PHRASES,
  ERROR_PHRASES,
  IDLE_QUIPS,
  THINKING_PHRASES,
  PROGRESS_PHRASES,
  REFINED_AFFIRMATIVES,
  REFINED_TRANSITIONS,
  Voice,
  voice,
  getRandomPhrase,
  getGreeting,
  getCompletionPhrase,
  getErrorPhrase,
  getIdleQuip,
  getThinkingPhrase,
  getProgressPhrase,
  getAffirmative,
  flavorResponse,
  createGreetingResponse,
  createCompletionResponse,
  createErrorResponse,
  type Personality,
  type FlavoredResponse,
} from "./voice.js";

// Brand Identity
export {
  BRAND,
  getBrandedHeader,
  getCompactHeader,
  brandText,
  getSpinnerFrame,
  getStatusIcon,
  createBrandedBox,
  createWelcomeBanner,
  createCompactWelcome,
  type BrandColor,
  type BrandIcon,
} from "./brand.js";
