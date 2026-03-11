/**
 * 8gent Code - Animated Status Verbs
 *
 * These cycle randomly during thinking/processing to give 8gent
 * its refined, witty, infinite gentleman personality.
 */

// ============================================
// Thinking Verbs - Used during processing
// ============================================

export const THINKING_VERBS = [
  // Gentleman/Refined
  "Contemplating...",
  "Deliberating...",
  "Musing...",
  "Pondering elegantly...",
  "Ruminating...",
  "Considering the possibilities...",
  "Reflecting with grace...",
  "Meditating upon this...",
  "Weighing options carefully...",
  "Consulting the archives...",

  // Infinity/8 themed (core brand)
  "Looping infinitely...",
  "Recursing gracefully...",
  "Iterating endlessly...",
  "Spiraling inward...",
  "Transcending limits...",
  "Calculating to infinity...",
  "Traversing the endless...",
  "Embracing the infinite...",
  "Folding space-time...",
  "Approaching asymptote...",

  // Coder wit
  "Adjusting monocle...",
  "Polishing algorithms...",
  "Brewing logic...",
  "Refactoring reality...",
  "Compiling thoughts...",
  "Debugging the universe...",
  "Optimizing existence...",
  "Garbage collecting doubts...",
  "Allocating brilliance...",
  "Parsing possibilities...",
  "Linking dependencies...",
  "Hashing solutions...",

  // Agent swagger
  "Orchestrating...",
  "Deploying brilliance...",
  "Architecting solutions...",
  "Engineering elegance...",
  "Crafting perfection...",
  "Conducting the symphony...",
  "Weaving excellence...",
  "Distilling wisdom...",
  "Channeling mastery...",
  "Manifesting results...",
];

// ============================================
// Executing Verbs - Used during tool execution
// ============================================

export const EXECUTING_VERBS = [
  "Executing with precision...",
  "Making it happen...",
  "Wielding tools...",
  "Operating gracefully...",
  "Performing magic...",
  "Manifesting code...",
  "Applying changes...",
  "Transforming reality...",
  "Implementing elegantly...",
  "Enacting the plan...",
  "Unleashing capability...",
  "Delivering results...",
  "Forging solutions...",
  "Sculpting perfection...",
  "Materializing vision...",
];

// ============================================
// Planning Verbs - Used during planning phase
// ============================================

export const PLANNING_VERBS = [
  "Scheming brilliantly...",
  "Strategizing...",
  "Plotting the course...",
  "Mapping infinity...",
  "Charting the path...",
  "Devising approach...",
  "Formulating strategy...",
  "Designing the blueprint...",
  "Architecting the plan...",
  "Calculating trajectories...",
  "Envisioning outcomes...",
  "Laying groundwork...",
  "Preparing the canvas...",
  "Setting the stage...",
];

// ============================================
// Status Verb Types
// ============================================

export type StatusVerbType = "thinking" | "executing" | "planning";

// ============================================
// Verb Selection Utilities
// ============================================

/**
 * Get a random verb from the specified category
 */
export function getRandomVerb(type: StatusVerbType): string {
  const verbs = getVerbsForType(type);
  return verbs[Math.floor(Math.random() * verbs.length)];
}

/**
 * Get the verb array for a given type
 */
export function getVerbsForType(type: StatusVerbType): string[] {
  switch (type) {
    case "thinking":
      return THINKING_VERBS;
    case "executing":
      return EXECUTING_VERBS;
    case "planning":
      return PLANNING_VERBS;
    default:
      return THINKING_VERBS;
  }
}

/**
 * Get a random verb different from the current one
 */
export function getNextVerb(type: StatusVerbType, currentVerb: string): string {
  const verbs = getVerbsForType(type);
  let next = currentVerb;

  // Keep trying until we get a different verb (or give up after 10 tries)
  let attempts = 0;
  while (next === currentVerb && attempts < 10) {
    next = verbs[Math.floor(Math.random() * verbs.length)];
    attempts++;
  }

  return next;
}

// ============================================
// StatusVerbs Class - Manages animated cycling
// ============================================

export class StatusVerbs {
  private currentVerb: string;
  private type: StatusVerbType;
  private interval: ReturnType<typeof setInterval> | null = null;
  private onChange: ((verb: string) => void) | null = null;

  constructor(type: StatusVerbType = "thinking") {
    this.type = type;
    this.currentVerb = getRandomVerb(type);
  }

  /**
   * Start cycling through verbs
   * @param type - The type of verbs to cycle through
   * @param onChange - Callback when verb changes (for React state updates)
   * @param intervalMs - Base interval in milliseconds (will add some randomness)
   */
  start(
    type: StatusVerbType = this.type,
    onChange?: (verb: string) => void,
    intervalMs: number = 2000
  ): void {
    this.stop(); // Clear any existing interval

    this.type = type;
    this.currentVerb = getRandomVerb(type);
    this.onChange = onChange || null;

    // Trigger initial callback
    if (this.onChange) {
      this.onChange(this.currentVerb);
    }

    // Start cycling with slight randomness (intervalMs to intervalMs + 1000ms)
    const tick = () => {
      this.currentVerb = getNextVerb(this.type, this.currentVerb);
      if (this.onChange) {
        this.onChange(this.currentVerb);
      }
    };

    // Use recursive setTimeout for variable intervals
    const scheduleNext = () => {
      const delay = intervalMs + Math.random() * 1000;
      this.interval = setTimeout(() => {
        tick();
        scheduleNext();
      }, delay) as unknown as ReturnType<typeof setInterval>;
    };

    scheduleNext();
  }

  /**
   * Stop cycling and return the final verb
   */
  stop(): string {
    if (this.interval !== null) {
      clearTimeout(this.interval as unknown as number);
      this.interval = null;
    }
    return this.currentVerb;
  }

  /**
   * Get the current verb without stopping
   */
  getCurrentVerb(): string {
    return this.currentVerb;
  }

  /**
   * Change the type of verbs being cycled
   */
  setType(type: StatusVerbType): void {
    this.type = type;
    this.currentVerb = getRandomVerb(type);
    if (this.onChange) {
      this.onChange(this.currentVerb);
    }
  }
}

// ============================================
// Singleton instance for global use
// ============================================

export const statusVerbs = new StatusVerbs();

export default StatusVerbs;
