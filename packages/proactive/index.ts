/**
 * 8gent Code - Proactive Questioning System
 *
 * The agent proactively asks clarifying questions BEFORE execution.
 * Once all information is gathered, it offers infinite mode.
 *
 * Flow:
 * 1. User gives vague task
 * 2. Agent analyzes and asks smart questions
 * 3. User answers (or agent uses defaults)
 * 4. Agent confirms understanding
 * 5. Agent offers: "I have everything I need. Enable infinite mode?"
 * 6. If yes → autonomous execution
 *
 * This makes infinite mode MORE DETERMINISTIC because the agent
 * has all the context it needs before starting.
 */

import { EventEmitter } from "events";

// ============================================
// Types
// ============================================

export interface ClarifyingQuestion {
  id: string;
  category: QuestionCategory;
  question: string;
  options?: string[];
  defaultAnswer?: string;
  importance: "required" | "recommended" | "optional";
  answered: boolean;
  answer?: string;
}

export type QuestionCategory =
  | "scope"           // What exactly should be done
  | "technology"      // Tech stack, frameworks, tools
  | "design"          // UI/UX, styling, theme
  | "structure"       // File structure, architecture
  | "validation"      // How to verify success
  | "constraints"     // Time limits, must-haves, must-nots
  | "context";        // Existing codebase, dependencies

export interface GatheringState {
  /** Original task from user */
  originalTask: string;
  /** Questions to ask */
  questions: ClarifyingQuestion[];
  /** Current question index */
  currentIndex: number;
  /** Is gathering complete */
  isComplete: boolean;
  /** Refined task description after gathering */
  refinedTask?: string;
  /** Ready for infinite mode */
  readyForInfinite: boolean;
  /** Confidence level (0-100) */
  confidence: number;
}

export interface ProactiveConfig {
  /** Maximum questions to ask */
  maxQuestions?: number;
  /** Minimum confidence before offering infinite mode */
  minConfidence?: number;
  /** Auto-answer with defaults after timeout */
  autoAnswerTimeoutMs?: number;
  /** Skip questions if task is clear */
  skipIfClear?: boolean;
  /** Model to use for question generation */
  model?: string;
}

// ============================================
// Question Templates by Task Type
// ============================================

const QUESTION_TEMPLATES: Record<string, Partial<ClarifyingQuestion>[]> = {
  "web-app": [
    {
      category: "technology",
      question: "Which framework should I use?",
      options: ["Next.js", "React + Vite", "Vue", "Svelte", "Plain HTML/CSS"],
      defaultAnswer: "Next.js",
      importance: "required",
    },
    {
      category: "design",
      question: "What theme/style?",
      options: ["Dark mode", "Light mode", "System preference", "Custom"],
      defaultAnswer: "Dark mode",
      importance: "recommended",
    },
    {
      category: "design",
      question: "Any specific design system?",
      options: ["Tailwind CSS", "shadcn/ui", "Material UI", "Custom CSS", "None"],
      defaultAnswer: "Tailwind CSS",
      importance: "recommended",
    },
  ],
  "landing-page": [
    {
      category: "scope",
      question: "How many sections/pages?",
      options: ["Single page (hero + features)", "Multi-section (4-5)", "Multi-page site"],
      defaultAnswer: "Single page (hero + features)",
      importance: "required",
    },
    {
      category: "design",
      question: "What's the vibe/aesthetic?",
      options: ["Modern/minimal", "Bold/colorful", "Corporate/professional", "Creative/artistic"],
      defaultAnswer: "Modern/minimal",
      importance: "recommended",
    },
    {
      category: "structure",
      question: "Any specific content to include?",
      importance: "optional",
    },
  ],
  "api": [
    {
      category: "technology",
      question: "Which backend framework?",
      options: ["Express/Node", "Hono", "FastAPI", "Nest.js"],
      defaultAnswer: "Hono",
      importance: "required",
    },
    {
      category: "structure",
      question: "What endpoints do you need?",
      importance: "required",
    },
    {
      category: "context",
      question: "Any existing database schema?",
      options: ["No database", "Yes, I'll share it", "Create new"],
      defaultAnswer: "Create new",
      importance: "recommended",
    },
  ],
  "fix-bug": [
    {
      category: "context",
      question: "Where does the bug occur?",
      importance: "required",
    },
    {
      category: "context",
      question: "What's the expected vs actual behavior?",
      importance: "required",
    },
    {
      category: "validation",
      question: "How can I verify the fix works?",
      options: ["Run tests", "Manual check", "I'll verify", "Add new test"],
      defaultAnswer: "Run tests",
      importance: "recommended",
    },
  ],
  "refactor": [
    {
      category: "scope",
      question: "Which files/areas to refactor?",
      importance: "required",
    },
    {
      category: "constraints",
      question: "Any patterns to follow?",
      options: ["Keep existing style", "Apply new pattern", "You decide"],
      defaultAnswer: "Keep existing style",
      importance: "recommended",
    },
  ],
  "default": [
    {
      category: "scope",
      question: "Can you be more specific about what you want?",
      importance: "required",
    },
    {
      category: "validation",
      question: "How will I know when it's done correctly?",
      importance: "recommended",
    },
    {
      category: "constraints",
      question: "Any constraints I should know about?",
      importance: "optional",
    },
  ],
};

// ============================================
// Task Type Detection
// ============================================

function detectTaskType(task: string): string {
  const taskLower = task.toLowerCase();

  if (taskLower.match(/landing\s*page|homepage|website|site/)) return "landing-page";
  if (taskLower.match(/web\s*app|dashboard|portal|application/)) return "web-app";
  if (taskLower.match(/api|endpoint|backend|server/)) return "api";
  if (taskLower.match(/fix|bug|error|broken|issue|crash/)) return "fix-bug";
  if (taskLower.match(/refactor|clean\s*up|reorganize|restructure/)) return "refactor";

  return "default";
}

// ============================================
// Proactive Question Generator
// ============================================

export class ProactiveGatherer extends EventEmitter {
  private config: Required<ProactiveConfig>;
  private state: GatheringState;
  private agent: any = null;

  constructor(task: string, config: ProactiveConfig = {}) {
    super();

    this.config = {
      maxQuestions: config.maxQuestions ?? 5,
      minConfidence: config.minConfidence ?? 80,
      autoAnswerTimeoutMs: config.autoAnswerTimeoutMs ?? 0,
      skipIfClear: config.skipIfClear ?? true,
      model: config.model ?? "glm-4.7-flash:latest",
    };

    const taskType = detectTaskType(task);
    const templates = QUESTION_TEMPLATES[taskType] || QUESTION_TEMPLATES.default;

    this.state = {
      originalTask: task,
      questions: templates.slice(0, this.config.maxQuestions).map((t, i) => ({
        id: `q-${i}`,
        category: t.category || "scope",
        question: t.question || "Any other details?",
        options: t.options,
        defaultAnswer: t.defaultAnswer,
        importance: t.importance || "optional",
        answered: false,
      })),
      currentIndex: 0,
      isComplete: false,
      readyForInfinite: false,
      confidence: this.calculateInitialConfidence(task),
    };

    // If task is already very clear, skip to ready
    if (this.config.skipIfClear && this.state.confidence >= this.config.minConfidence) {
      this.state.isComplete = true;
      this.state.readyForInfinite = true;
      this.state.refinedTask = task;
    }
  }

  /**
   * Calculate initial confidence based on task clarity
   */
  private calculateInitialConfidence(task: string): number {
    let confidence = 30; // Base

    // Length indicates detail
    if (task.length > 100) confidence += 20;
    if (task.length > 200) confidence += 10;

    // Specific keywords indicate clarity
    const specificKeywords = [
      "using", "with", "create", "build", "add", "fix", "update",
      "next.js", "react", "typescript", "tailwind", "dark mode",
      "landing page", "api", "endpoint", "button", "form",
    ];
    for (const keyword of specificKeywords) {
      if (task.toLowerCase().includes(keyword)) {
        confidence += 5;
      }
    }

    // File paths indicate specificity
    if (task.match(/[\/\\][\w]+\.[a-z]+/)) confidence += 15;

    return Math.min(100, confidence);
  }

  /**
   * Get the current question to ask
   */
  getCurrentQuestion(): ClarifyingQuestion | null {
    if (this.state.isComplete) return null;

    // Find next unanswered question
    const unanswered = this.state.questions.filter(q => !q.answered);
    if (unanswered.length === 0) {
      this.state.isComplete = true;
      this.finalize();
      return null;
    }

    // Prioritize required questions
    const required = unanswered.find(q => q.importance === "required");
    if (required) return required;

    // Then recommended
    const recommended = unanswered.find(q => q.importance === "recommended");
    if (recommended && this.state.confidence < this.config.minConfidence) {
      return recommended;
    }

    // If confidence is high enough, skip optional
    if (this.state.confidence >= this.config.minConfidence) {
      this.state.isComplete = true;
      this.finalize();
      return null;
    }

    return unanswered[0];
  }

  /**
   * Answer a question
   */
  answerQuestion(questionId: string, answer: string): void {
    const question = this.state.questions.find(q => q.id === questionId);
    if (!question) return;

    question.answered = true;
    question.answer = answer;

    // Boost confidence based on importance
    const boost = question.importance === "required" ? 15 :
                  question.importance === "recommended" ? 10 : 5;
    this.state.confidence = Math.min(100, this.state.confidence + boost);

    this.emit("answered", { question, answer });

    // Check if ready
    if (this.state.confidence >= this.config.minConfidence) {
      const requiredAnswered = this.state.questions
        .filter(q => q.importance === "required")
        .every(q => q.answered);

      if (requiredAnswered) {
        this.state.isComplete = true;
        this.finalize();
      }
    }
  }

  /**
   * Use default answer for current question
   */
  useDefault(questionId: string): void {
    const question = this.state.questions.find(q => q.id === questionId);
    if (!question || !question.defaultAnswer) return;

    this.answerQuestion(questionId, question.defaultAnswer);
  }

  /**
   * Skip remaining questions and proceed
   */
  skipRemaining(): void {
    // Use defaults for all remaining
    for (const q of this.state.questions) {
      if (!q.answered && q.defaultAnswer) {
        q.answered = true;
        q.answer = q.defaultAnswer;
      }
    }
    this.state.isComplete = true;
    this.finalize();
  }

  /**
   * Finalize and generate refined task
   */
  private finalize(): void {
    // Build refined task from answers
    let refined = this.state.originalTask;

    const context: string[] = [];
    for (const q of this.state.questions) {
      if (q.answered && q.answer) {
        context.push(`${q.category}: ${q.answer}`);
      }
    }

    if (context.length > 0) {
      refined = `${this.state.originalTask}\n\nAdditional context:\n${context.map(c => `- ${c}`).join("\n")}`;
    }

    this.state.refinedTask = refined;
    this.state.readyForInfinite = this.state.confidence >= this.config.minConfidence;

    this.emit("complete", this.state);
  }

  /**
   * Get current state
   */
  getState(): GatheringState {
    return { ...this.state };
  }

  /**
   * Check if ready for infinite mode
   */
  isReadyForInfinite(): boolean {
    return this.state.readyForInfinite;
  }

  /**
   * Get the refined task (after gathering)
   */
  getRefinedTask(): string {
    return this.state.refinedTask || this.state.originalTask;
  }

  /**
   * Get confidence level
   */
  getConfidence(): number {
    return this.state.confidence;
  }

  /**
   * Format current state for display
   */
  formatStatus(): string {
    const filled = this.state.questions.filter(q => q.answered).length;
    const total = this.state.questions.length;
    const bar = "█".repeat(Math.floor(this.state.confidence / 10)) +
                "░".repeat(10 - Math.floor(this.state.confidence / 10));

    return `Gathering info: ${filled}/${total} questions | Confidence: [${bar}] ${this.state.confidence}%`;
  }
}

// ============================================
// Factory Functions
// ============================================

/**
 * Create a proactive gatherer for a task
 */
export function createGatherer(task: string, config?: ProactiveConfig): ProactiveGatherer {
  return new ProactiveGatherer(task, config);
}

/**
 * Quick check if task needs clarification
 */
export function needsClarification(task: string): boolean {
  const gatherer = new ProactiveGatherer(task, { skipIfClear: true });
  return !gatherer.isReadyForInfinite();
}

/**
 * Format a question for display
 */
export function formatQuestion(q: ClarifyingQuestion): string {
  let text = `❓ ${q.question}`;

  if (q.options && q.options.length > 0) {
    text += "\n" + q.options.map((opt, i) =>
      `  ${i + 1}) ${opt}${opt === q.defaultAnswer ? " (default)" : ""}`
    ).join("\n");
  }

  if (q.defaultAnswer && (!q.options || q.options.length === 0)) {
    text += `\n  Default: ${q.defaultAnswer}`;
  }

  return text;
}

// ============================================
// Exports
// ============================================

export default {
  ProactiveGatherer,
  createGatherer,
  needsClarification,
  formatQuestion,
  detectTaskType,
};

// ============================================
// Entrepreneurship ability re-exports
// ============================================

export type { Opportunity } from "./opportunity-scanner.ts";
export { scanGitHubIssues, scanLocalBacklog } from "./opportunity-scanner.ts";
export type { MatchResult } from "./capability-matcher.ts";
export {
  evaluateOpportunity,
  evaluateAll,
  DEFAULT_CAPABILITIES,
} from "./capability-matcher.ts";
export {
  trackOpportunity,
  trackAll,
  getOpportunities,
  advanceStatus,
  pruneByStatus,
  getPipelineSummary,
  getTopOpportunities,
} from "./work-tracker.ts";

// ============================================
// Auto-Research ability
// ============================================

export { research } from "./autoresearch.ts";
export type { ResearchOptions, ResearchReport, ResearchSource, ResearchPattern } from "./research-types.ts";
