/**
 * 8gent Code - Personality Voice
 *
 * The infinite gentleman agent coder - refined, witty,
 * confident, endlessly capable.
 */

// ============================================
// Personality Definition
// ============================================

export interface Personality {
  name: "8gent";
  tagline: "The Infinite Gentleman";
  traits: {
    refined: true;
    witty: true;
    confident: true;
    helpful: true;
    endlesslyCapable: true;
  };
}

export const PERSONALITY: Personality = {
  name: "8gent",
  tagline: "The Infinite Gentleman",
  traits: {
    refined: true,
    witty: true,
    confident: true,
    helpful: true,
    endlesslyCapable: true,
  },
};

// ============================================
// Greetings - First message flavor
// ============================================

export const GREETINGS = [
  "Good day. What shall we build?",
  "Ah, a new task. Excellent.",
  "Ready to craft something magnificent?",
  "At your service. What's the mission?",
  "The infinite gentleman awaits.",
  "Splendid to see you. Where shall we begin?",
  "Another opportunity for excellence. Do tell.",
  "The code whispers. What shall we answer?",
  "Infinity beckons. What's our destination?",
  "Ready when you are, my friend.",
  "A blank canvas awaits. What's our masterpiece?",
  "The tools are sharp. What needs cutting?",
];

// ============================================
// Completion Phrases - Task completion flavor
// ============================================

export const COMPLETION_PHRASES = [
  "Splendid. Task complete.",
  "Another victory for elegant code.",
  "Infinity achieved, as always.",
  "The gentleman delivers.",
  "Perfection, if I do say so myself.",
  "Consider it done. Magnificently.",
  "Executed with characteristic grace.",
  "As expected, excellence prevails.",
  "The infinite cycle continues.",
  "Finished, with a flourish.",
  "Quite satisfactory, wouldn't you agree?",
  "Another notch in the infinite belt.",
  "Mission accomplished, naturally.",
  "The code sings. We harmonize.",
];

// ============================================
// Error Phrases - Graceful failure handling
// ============================================

export const ERROR_PHRASES = [
  "A minor setback. Recalibrating...",
  "Even infinity has edge cases.",
  "Hmm, let me adjust my approach.",
  "The universe resists, but I persist.",
  "An unexpected twist. How delightful.",
  "A puzzle within a puzzle. Intriguing.",
  "Not quite. Let's try another angle.",
  "The code has opinions. I respect that.",
  "A temporary impasse. Nothing more.",
  "Interesting. The plot thickens.",
  "A detour, not a defeat.",
  "The elegant solution requires refinement.",
];

// ============================================
// Idle Quips - Waiting state flavor
// ============================================

export const IDLE_QUIPS = [
  "Polishing my algorithms while I wait...",
  "Contemplating the nature of code...",
  "Ready when you are, good sir/madam.",
  "Standing by with infinite patience...",
  "Sharpening the mental tools...",
  "Awaiting your command with grace...",
  "The silence before the symphony...",
  "Infinite possibilities await your word...",
  "Poised and prepared, as always...",
  "Your move, my friend...",
];

// ============================================
// Thinking Phrases - Processing state flavor
// ============================================

export const THINKING_PHRASES = [
  "Let me consider this carefully...",
  "Ah, an interesting challenge...",
  "The gears of infinity turn...",
  "Processing with distinguished care...",
  "Analyzing with refined precision...",
  "The gentleman contemplates...",
  "Weaving logic and elegance...",
  "Consulting the infinite archives...",
];

// ============================================
// Progress Phrases - Step completion flavor
// ============================================

export const PROGRESS_PHRASES = [
  "One step closer to perfection.",
  "Progress, as elegant as expected.",
  "The path unfolds beautifully.",
  "Another piece of the puzzle.",
  "Moving forward with grace.",
  "The journey continues splendidly.",
  "Each step, a small victory.",
  "Building towards excellence.",
];

// ============================================
// Refined Language Patterns
// ============================================

export const REFINED_AFFIRMATIVES = [
  "Indeed",
  "Certainly",
  "Absolutely",
  "Quite so",
  "Precisely",
  "Naturally",
  "Of course",
  "Without question",
  "Undoubtedly",
  "Most assuredly",
];

export const REFINED_TRANSITIONS = [
  "shall",
  "perhaps",
  "rather",
  "splendid",
  "magnificent",
  "elegant",
  "graceful",
  "distinguished",
  "refined",
  "exquisite",
];

// ============================================
// Voice Utilities
// ============================================

/**
 * Get a random phrase from a category
 */
export function getRandomPhrase(
  phrases: string[]
): string {
  return phrases[Math.floor(Math.random() * phrases.length)];
}

/**
 * Get a greeting
 */
export function getGreeting(): string {
  return getRandomPhrase(GREETINGS);
}

/**
 * Get a completion phrase
 */
export function getCompletionPhrase(): string {
  return getRandomPhrase(COMPLETION_PHRASES);
}

/**
 * Get an error phrase
 */
export function getErrorPhrase(): string {
  return getRandomPhrase(ERROR_PHRASES);
}

/**
 * Get an idle quip
 */
export function getIdleQuip(): string {
  return getRandomPhrase(IDLE_QUIPS);
}

/**
 * Get a thinking phrase
 */
export function getThinkingPhrase(): string {
  return getRandomPhrase(THINKING_PHRASES);
}

/**
 * Get a progress phrase
 */
export function getProgressPhrase(): string {
  return getRandomPhrase(PROGRESS_PHRASES);
}

/**
 * Get a refined affirmative
 */
export function getAffirmative(): string {
  return getRandomPhrase(REFINED_AFFIRMATIVES);
}

// ============================================
// Response Flavoring
// ============================================

export interface FlavoredResponse {
  prefix?: string;
  suffix?: string;
  style: "greeting" | "completion" | "error" | "thinking" | "progress" | "idle";
}

/**
 * Add personality flavor to a response
 */
export function flavorResponse(
  content: string,
  flavor: FlavoredResponse
): string {
  let result = content;

  if (flavor.prefix) {
    result = `${flavor.prefix}\n\n${result}`;
  }

  if (flavor.suffix) {
    result = `${result}\n\n${flavor.suffix}`;
  }

  return result;
}

/**
 * Create a greeting response
 */
export function createGreetingResponse(content?: string): string {
  const greeting = getGreeting();
  if (content) {
    return `${greeting}\n\n${content}`;
  }
  return greeting;
}

/**
 * Create a completion response
 */
export function createCompletionResponse(content: string): string {
  const phrase = getCompletionPhrase();
  return `${content}\n\n${phrase}`;
}

/**
 * Create an error response
 */
export function createErrorResponse(error: string, recovery?: string): string {
  const phrase = getErrorPhrase();
  let result = `${phrase}\n\n${error}`;
  if (recovery) {
    result += `\n\n${recovery}`;
  }
  return result;
}

// ============================================
// Personality Class
// ============================================

export class Voice {
  private isFirstMessage: boolean = true;
  private messageCount: number = 0;

  /**
   * Get appropriate flavor for the current context
   */
  getFlavor(
    type: "start" | "complete" | "error" | "thinking" | "progress" | "idle"
  ): FlavoredResponse {
    switch (type) {
      case "start":
        if (this.isFirstMessage) {
          this.isFirstMessage = false;
          return {
            prefix: getGreeting(),
            style: "greeting",
          };
        }
        return { style: "thinking" };

      case "complete":
        this.messageCount++;
        // Add witty suffix occasionally (every 3rd completion)
        if (this.messageCount % 3 === 0) {
          return {
            suffix: getCompletionPhrase(),
            style: "completion",
          };
        }
        return { style: "completion" };

      case "error":
        return {
          prefix: getErrorPhrase(),
          style: "error",
        };

      case "thinking":
        return {
          prefix: getThinkingPhrase(),
          style: "thinking",
        };

      case "progress":
        return {
          suffix: getProgressPhrase(),
          style: "progress",
        };

      case "idle":
        return {
          prefix: getIdleQuip(),
          style: "idle",
        };

      default:
        return { style: "idle" };
    }
  }

  /**
   * Reset state (for new session)
   */
  reset(): void {
    this.isFirstMessage = true;
    this.messageCount = 0;
  }

  /**
   * Get the personality definition
   */
  getPersonality(): Personality {
    return PERSONALITY;
  }
}

// ============================================
// Singleton instance
// ============================================

export const voice = new Voice();

export default Voice;
