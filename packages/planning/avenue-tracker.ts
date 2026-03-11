/**
 * 8gent Code - Multi-Avenue Planning
 *
 * Tracks multiple possible directions the human might go.
 * Each "avenue" is a potential future path with pre-generated plans.
 *
 * When the human chooses a direction, that avenue becomes active,
 * unused avenues are discarded, and new predictions are generated.
 */

// Import ExecutionContext from proactive-planner to avoid duplication
import type { ExecutionContext } from "./proactive-planner.js";

// ============================================
// Types
// ============================================

export interface Avenue {
  id: string;
  name: string;
  description: string;
  probability: number; // 0-1, likelihood this path will be chosen
  category: AvenueCategory;
  plan: PreGeneratedPlan;
  triggers: string[]; // Keywords/phrases that would activate this avenue
  createdAt: Date;
  lastUpdated: Date;
  depth: number; // How many steps ahead this avenue plans
}

export type AvenueCategory =
  | "feature" // Building something new
  | "bugfix" // Fixing issues
  | "refactor" // Improving code
  | "explore" // Understanding code
  | "test" // Adding/running tests
  | "deploy" // Deployment tasks
  | "config" // Configuration changes
  | "docs"; // Documentation

export interface PreGeneratedPlan {
  goal: string;
  steps: PreGeneratedStep[];
  estimatedTokens: number;
  estimatedTime: number; // in seconds
}

export interface PreGeneratedStep {
  id: string;
  description: string;
  tool: string;
  input: Record<string, unknown>;
  dependencies: string[];
  optional: boolean;
}

export interface AvenueContext {
  currentTask: string;
  recentAvenues: string[]; // IDs of recently chosen avenues
  projectType: ProjectType;
  userPatterns: UserPattern[];
}

export type ProjectType =
  | "web-frontend"
  | "web-backend"
  | "cli"
  | "library"
  | "monorepo"
  | "unknown";

export interface UserPattern {
  pattern: string;
  frequency: number;
  lastUsed: Date;
}

// ============================================
// Avenue Tracker
// ============================================

export class AvenueTracker {
  private avenues: Map<string, Avenue> = new Map();
  private activeAvenue: Avenue | null = null;
  private context: AvenueContext;
  private maxAvenues = 5;
  private planDepth = 5; // Steps ahead for each avenue

  constructor() {
    this.context = {
      currentTask: "",
      recentAvenues: [],
      projectType: "unknown",
      userPatterns: [],
    };
  }

  /**
   * Generate multiple avenues based on current context
   */
  async generateAvenues(task: string, context: ExecutionContext): Promise<Avenue[]> {
    this.context.currentTask = task;

    // Clear old avenues
    this.avenues.clear();

    // Detect project type if not set
    if (this.context.projectType === "unknown") {
      this.context.projectType = await this.detectProjectType(context);
    }

    // Generate avenues based on task analysis
    const taskLower = task.toLowerCase();
    const avenues: Avenue[] = [];

    // Feature avenue
    if (this.isPossibleFeatureRequest(taskLower)) {
      avenues.push(this.createFeatureAvenue(task));
    }

    // Bugfix avenue
    if (this.isPossibleBugfix(taskLower)) {
      avenues.push(this.createBugfixAvenue(task));
    }

    // Refactor avenue
    if (this.isPossibleRefactor(taskLower)) {
      avenues.push(this.createRefactorAvenue(task));
    }

    // Exploration avenue (always included)
    avenues.push(this.createExplorationAvenue(task));

    // Testing avenue
    if (this.isPossibleTesting(taskLower)) {
      avenues.push(this.createTestingAvenue(task));
    }

    // Calculate probabilities based on user patterns
    this.calculateProbabilities(avenues);

    // Sort by probability
    avenues.sort((a, b) => b.probability - a.probability);

    // Keep top N avenues
    const topAvenues = avenues.slice(0, this.maxAvenues);

    // Store in map
    for (const avenue of topAvenues) {
      this.avenues.set(avenue.id, avenue);
    }

    return topAvenues;
  }

  /**
   * Activate an avenue when user chooses it
   */
  activateAvenue(avenueId: string): Avenue | null {
    const avenue = this.avenues.get(avenueId);
    if (!avenue) return null;

    this.activeAvenue = avenue;

    // Track this choice for future predictions
    this.context.recentAvenues.unshift(avenueId);
    this.context.recentAvenues = this.context.recentAvenues.slice(0, 10);

    // Update user patterns
    this.updateUserPatterns(avenue);

    // Clear other avenues
    for (const [id] of this.avenues) {
      if (id !== avenueId) {
        this.avenues.delete(id);
      }
    }

    return avenue;
  }

  /**
   * Auto-detect which avenue matches user input
   */
  matchAvenue(userInput: string): Avenue | null {
    const inputLower = userInput.toLowerCase();
    let bestMatch: Avenue | null = null;
    let bestScore = 0;

    for (const avenue of this.avenues.values()) {
      let score = 0;

      // Check trigger matches
      for (const trigger of avenue.triggers) {
        if (inputLower.includes(trigger.toLowerCase())) {
          score += 2;
        }
      }

      // Check description match
      const descWords = avenue.description.toLowerCase().split(/\s+/);
      for (const word of descWords) {
        if (word.length > 3 && inputLower.includes(word)) {
          score += 1;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = avenue;
      }
    }

    return bestScore >= 2 ? bestMatch : null;
  }

  /**
   * Get all current avenues
   */
  getAvenues(): Avenue[] {
    return Array.from(this.avenues.values());
  }

  /**
   * Get active avenue
   */
  getActiveAvenue(): Avenue | null {
    return this.activeAvenue;
  }

  /**
   * Get plan for an avenue
   */
  getAvenuePlan(avenueId: string): PreGeneratedPlan | null {
    return this.avenues.get(avenueId)?.plan || null;
  }

  /**
   * Advance the active avenue to next step
   */
  advanceActiveAvenue(): PreGeneratedStep | null {
    if (!this.activeAvenue) return null;

    const plan = this.activeAvenue.plan;
    const nextStep = plan.steps.find(
      (step) =>
        !step.dependencies.some((dep) =>
          plan.steps.find((s) => s.id === dep && !this.isStepCompleted(s.id))
        )
    );

    return nextStep || null;
  }

  /**
   * Mark a step as completed in the active avenue
   */
  private completedSteps: Set<string> = new Set();

  markStepCompleted(stepId: string): void {
    this.completedSteps.add(stepId);
  }

  isStepCompleted(stepId: string): boolean {
    return this.completedSteps.has(stepId);
  }

  // ============================================
  // Avenue Creation
  // ============================================

  private createFeatureAvenue(task: string): Avenue {
    const id = this.generateId();
    return {
      id,
      name: "Implement Feature",
      description: `Build new functionality: ${this.extractKeywords(task)}`,
      probability: 0.3,
      category: "feature",
      plan: this.generateFeaturePlan(task),
      triggers: ["add", "create", "implement", "build", "new", "feature"],
      createdAt: new Date(),
      lastUpdated: new Date(),
      depth: this.planDepth,
    };
  }

  private createBugfixAvenue(task: string): Avenue {
    const id = this.generateId();
    return {
      id,
      name: "Fix Bug",
      description: `Debug and fix issue: ${this.extractKeywords(task)}`,
      probability: 0.3,
      category: "bugfix",
      plan: this.generateBugfixPlan(task),
      triggers: ["fix", "bug", "error", "issue", "broken", "wrong", "not working"],
      createdAt: new Date(),
      lastUpdated: new Date(),
      depth: this.planDepth,
    };
  }

  private createRefactorAvenue(task: string): Avenue {
    const id = this.generateId();
    return {
      id,
      name: "Refactor Code",
      description: `Improve code quality: ${this.extractKeywords(task)}`,
      probability: 0.2,
      category: "refactor",
      plan: this.generateRefactorPlan(task),
      triggers: ["refactor", "improve", "clean", "optimize", "simplify"],
      createdAt: new Date(),
      lastUpdated: new Date(),
      depth: this.planDepth,
    };
  }

  private createExplorationAvenue(task: string): Avenue {
    const id = this.generateId();
    return {
      id,
      name: "Explore Codebase",
      description: `Understand the code: ${this.extractKeywords(task)}`,
      probability: 0.4,
      category: "explore",
      plan: this.generateExplorationPlan(task),
      triggers: ["understand", "explain", "show", "find", "where", "how", "what"],
      createdAt: new Date(),
      lastUpdated: new Date(),
      depth: this.planDepth,
    };
  }

  private createTestingAvenue(task: string): Avenue {
    const id = this.generateId();
    return {
      id,
      name: "Add Tests",
      description: `Create or run tests: ${this.extractKeywords(task)}`,
      probability: 0.2,
      category: "test",
      plan: this.generateTestingPlan(task),
      triggers: ["test", "spec", "coverage", "verify", "check"],
      createdAt: new Date(),
      lastUpdated: new Date(),
      depth: this.planDepth,
    };
  }

  // ============================================
  // Plan Generation
  // ============================================

  private generateFeaturePlan(task: string): PreGeneratedPlan {
    const keywords = this.extractKeywords(task);
    return {
      goal: `Implement feature: ${keywords}`,
      steps: [
        {
          id: `${this.generateId()}-1`,
          description: "Search for related existing code",
          tool: "search_symbols",
          input: { query: keywords },
          dependencies: [],
          optional: false,
        },
        {
          id: `${this.generateId()}-2`,
          description: "Get outline of relevant files",
          tool: "get_outline",
          input: { pattern: "src/**/*.ts" },
          dependencies: [],
          optional: false,
        },
        {
          id: `${this.generateId()}-3`,
          description: "Create implementation file",
          tool: "write_file",
          input: { path: "src/features/new-feature.ts" },
          dependencies: [],
          optional: false,
        },
        {
          id: `${this.generateId()}-4`,
          description: "Add tests for new feature",
          tool: "write_file",
          input: { path: "src/features/new-feature.test.ts" },
          dependencies: [],
          optional: true,
        },
        {
          id: `${this.generateId()}-5`,
          description: "Run tests to verify",
          tool: "exec",
          input: { command: "npm test" },
          dependencies: [],
          optional: false,
        },
      ],
      estimatedTokens: 3000,
      estimatedTime: 120,
    };
  }

  private generateBugfixPlan(task: string): PreGeneratedPlan {
    const keywords = this.extractKeywords(task);
    return {
      goal: `Fix bug: ${keywords}`,
      steps: [
        {
          id: `${this.generateId()}-1`,
          description: "Search for error-related code",
          tool: "search_symbols",
          input: { query: keywords },
          dependencies: [],
          optional: false,
        },
        {
          id: `${this.generateId()}-2`,
          description: "Get symbol details",
          tool: "get_symbol",
          input: { symbolId: "to-be-determined" },
          dependencies: [],
          optional: false,
        },
        {
          id: `${this.generateId()}-3`,
          description: "Apply fix",
          tool: "edit_file",
          input: {},
          dependencies: [],
          optional: false,
        },
        {
          id: `${this.generateId()}-4`,
          description: "Run tests to verify fix",
          tool: "exec",
          input: { command: "npm test" },
          dependencies: [],
          optional: false,
        },
        {
          id: `${this.generateId()}-5`,
          description: "Check for regression",
          tool: "exec",
          input: { command: "npm run test:integration" },
          dependencies: [],
          optional: true,
        },
      ],
      estimatedTokens: 2500,
      estimatedTime: 90,
    };
  }

  private generateRefactorPlan(task: string): PreGeneratedPlan {
    const keywords = this.extractKeywords(task);
    return {
      goal: `Refactor: ${keywords}`,
      steps: [
        {
          id: `${this.generateId()}-1`,
          description: "Analyze current structure",
          tool: "get_outline",
          input: { pattern: "**/*.ts" },
          dependencies: [],
          optional: false,
        },
        {
          id: `${this.generateId()}-2`,
          description: "Get symbols to refactor",
          tool: "search_symbols",
          input: { query: keywords },
          dependencies: [],
          optional: false,
        },
        {
          id: `${this.generateId()}-3`,
          description: "Apply refactoring changes",
          tool: "edit_file",
          input: {},
          dependencies: [],
          optional: false,
        },
        {
          id: `${this.generateId()}-4`,
          description: "Run linter",
          tool: "exec",
          input: { command: "npm run lint" },
          dependencies: [],
          optional: false,
        },
        {
          id: `${this.generateId()}-5`,
          description: "Run tests",
          tool: "exec",
          input: { command: "npm test" },
          dependencies: [],
          optional: false,
        },
      ],
      estimatedTokens: 2000,
      estimatedTime: 60,
    };
  }

  private generateExplorationPlan(task: string): PreGeneratedPlan {
    const keywords = this.extractKeywords(task);
    return {
      goal: `Understand: ${keywords}`,
      steps: [
        {
          id: `${this.generateId()}-1`,
          description: "Get file outline",
          tool: "get_outline",
          input: { pattern: "**/*.ts" },
          dependencies: [],
          optional: false,
        },
        {
          id: `${this.generateId()}-2`,
          description: "Search for relevant symbols",
          tool: "search_symbols",
          input: { query: keywords },
          dependencies: [],
          optional: false,
        },
        {
          id: `${this.generateId()}-3`,
          description: "Get symbol source code",
          tool: "get_symbol",
          input: { symbolId: "to-be-determined" },
          dependencies: [],
          optional: false,
        },
        {
          id: `${this.generateId()}-4`,
          description: "Find related tests",
          tool: "search_symbols",
          input: { query: keywords, pattern: "**/*.test.ts" },
          dependencies: [],
          optional: true,
        },
        {
          id: `${this.generateId()}-5`,
          description: "Check usage across codebase",
          tool: "search_symbols",
          input: { query: keywords },
          dependencies: [],
          optional: true,
        },
      ],
      estimatedTokens: 1500,
      estimatedTime: 30,
    };
  }

  private generateTestingPlan(task: string): PreGeneratedPlan {
    const keywords = this.extractKeywords(task);
    return {
      goal: `Test: ${keywords}`,
      steps: [
        {
          id: `${this.generateId()}-1`,
          description: "Find existing tests",
          tool: "get_outline",
          input: { pattern: "**/*.test.ts" },
          dependencies: [],
          optional: false,
        },
        {
          id: `${this.generateId()}-2`,
          description: "Get code to test",
          tool: "search_symbols",
          input: { query: keywords },
          dependencies: [],
          optional: false,
        },
        {
          id: `${this.generateId()}-3`,
          description: "Create test file",
          tool: "write_file",
          input: { path: "src/__tests__/new.test.ts" },
          dependencies: [],
          optional: false,
        },
        {
          id: `${this.generateId()}-4`,
          description: "Run tests",
          tool: "exec",
          input: { command: "npm test" },
          dependencies: [],
          optional: false,
        },
        {
          id: `${this.generateId()}-5`,
          description: "Check coverage",
          tool: "exec",
          input: { command: "npm run test:coverage" },
          dependencies: [],
          optional: true,
        },
      ],
      estimatedTokens: 2000,
      estimatedTime: 60,
    };
  }

  // ============================================
  // Detection Helpers
  // ============================================

  private isPossibleFeatureRequest(task: string): boolean {
    const patterns = ["add", "create", "implement", "build", "new", "feature", "make"];
    return patterns.some((p) => task.includes(p));
  }

  private isPossibleBugfix(task: string): boolean {
    const patterns = ["fix", "bug", "error", "issue", "broken", "wrong", "fail", "crash"];
    return patterns.some((p) => task.includes(p));
  }

  private isPossibleRefactor(task: string): boolean {
    const patterns = ["refactor", "improve", "clean", "optimize", "simplify", "reorganize"];
    return patterns.some((p) => task.includes(p));
  }

  private isPossibleTesting(task: string): boolean {
    const patterns = ["test", "spec", "coverage", "verify", "check", "validate"];
    return patterns.some((p) => task.includes(p));
  }

  private async detectProjectType(context: ExecutionContext): Promise<ProjectType> {
    // This would check package.json, file structure, etc.
    // For now, return unknown
    return "unknown";
  }

  private calculateProbabilities(avenues: Avenue[]): void {
    // Adjust probabilities based on user patterns
    for (const avenue of avenues) {
      const pattern = this.context.userPatterns.find((p) =>
        avenue.triggers.some((t) => p.pattern.includes(t))
      );
      if (pattern) {
        avenue.probability *= 1 + pattern.frequency * 0.1;
      }
    }

    // Normalize probabilities
    const total = avenues.reduce((sum, a) => sum + a.probability, 0);
    for (const avenue of avenues) {
      avenue.probability = avenue.probability / total;
    }
  }

  private updateUserPatterns(avenue: Avenue): void {
    for (const trigger of avenue.triggers) {
      const existing = this.context.userPatterns.find((p) => p.pattern === trigger);
      if (existing) {
        existing.frequency += 1;
        existing.lastUsed = new Date();
      } else {
        this.context.userPatterns.push({
          pattern: trigger,
          frequency: 1,
          lastUsed: new Date(),
        });
      }
    }

    // Keep only top 50 patterns
    this.context.userPatterns.sort((a, b) => b.frequency - a.frequency);
    this.context.userPatterns = this.context.userPatterns.slice(0, 50);
  }

  private extractKeywords(task: string): string {
    const stopWords = new Set([
      "the",
      "a",
      "an",
      "is",
      "are",
      "was",
      "were",
      "be",
      "been",
      "being",
      "have",
      "has",
      "had",
      "do",
      "does",
      "did",
      "will",
      "would",
      "could",
      "should",
      "may",
      "might",
      "must",
      "shall",
      "can",
      "need",
      "to",
      "of",
      "in",
      "for",
      "on",
      "with",
      "at",
      "by",
      "from",
      "as",
      "into",
      "through",
      "during",
      "before",
      "after",
      "above",
      "below",
      "between",
      "under",
      "again",
      "further",
      "then",
      "once",
      "here",
      "there",
      "when",
      "where",
      "why",
      "how",
      "all",
      "each",
      "few",
      "more",
      "most",
      "other",
      "some",
      "such",
      "no",
      "nor",
      "not",
      "only",
      "own",
      "same",
      "so",
      "than",
      "too",
      "very",
      "just",
      "and",
      "but",
      "if",
      "or",
      "because",
      "as",
      "until",
      "while",
    ]);

    return task
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 2 && !stopWords.has(word))
      .slice(0, 5)
      .join(" ");
  }

  private generateId(): string {
    return `avenue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

// Singleton instance
let avenueTrackerInstance: AvenueTracker | null = null;

export function getAvenueTracker(): AvenueTracker {
  if (!avenueTrackerInstance) {
    avenueTrackerInstance = new AvenueTracker();
  }
  return avenueTrackerInstance;
}

export function resetAvenueTracker(): void {
  avenueTrackerInstance = null;
}
