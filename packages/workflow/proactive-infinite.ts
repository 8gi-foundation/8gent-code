/**
 * 8gent Code - Proactive → Infinite Workflow
 *
 * The complete flow:
 * 1. User gives task
 * 2. Agent proactively asks clarifying questions
 * 3. Once confident, agent offers infinite mode
 * 4. User confirms → autonomous execution
 *
 * This is THE way to use 8gent for complex tasks.
 * Maximum determinism through upfront clarity.
 */

import { EventEmitter } from "events";
import {
  ProactiveGatherer,
  createGatherer,
  formatQuestion,
  type ClarifyingQuestion,
  type GatheringState,
} from "../proactive";
import {
  InfiniteRunner,
  createInfiniteRunner,
  formatInfiniteState,
  type InfiniteState,
  type InfiniteConfig,
} from "../infinite";

// ============================================
// Types
// ============================================

export type WorkflowPhase =
  | "gathering"      // Asking questions
  | "confirming"     // Offering infinite mode
  | "executing"      // Running infinite loop
  | "complete"       // Done
  | "cancelled";     // User cancelled

export interface WorkflowState {
  phase: WorkflowPhase;
  task: string;
  gatheringState?: GatheringState;
  infiniteState?: InfiniteState;
  currentQuestion?: ClarifyingQuestion;
  startTime: Date;
  endTime?: Date;
}

export interface WorkflowConfig {
  /** Skip gathering if task is clear */
  skipGatheringIfClear?: boolean;
  /** Minimum confidence before offering infinite mode */
  minConfidence?: number;
  /** Maximum questions to ask */
  maxQuestions?: number;
  /** Infinite mode config */
  infiniteConfig?: Partial<InfiniteConfig>;
  /** Auto-confirm infinite mode (dangerous!) */
  autoConfirmInfinite?: boolean;
}

export type WorkflowEvent =
  | { type: "question"; question: ClarifyingQuestion }
  | { type: "answered"; questionId: string; answer: string }
  | { type: "ready"; refinedTask: string; confidence: number }
  | { type: "confirmed" }
  | { type: "cancelled" }
  | { type: "progress"; state: InfiniteState }
  | { type: "complete"; state: InfiniteState }
  | { type: "error"; error: Error };

// ============================================
// Workflow Controller
// ============================================

export class ProactiveInfiniteWorkflow extends EventEmitter {
  private config: Required<WorkflowConfig>;
  private state: WorkflowState;
  private gatherer?: ProactiveGatherer;
  private runner?: InfiniteRunner;

  constructor(task: string, config: WorkflowConfig = {}) {
    super();

    this.config = {
      skipGatheringIfClear: config.skipGatheringIfClear ?? true,
      minConfidence: config.minConfidence ?? 80,
      maxQuestions: config.maxQuestions ?? 5,
      infiniteConfig: config.infiniteConfig ?? {},
      autoConfirmInfinite: config.autoConfirmInfinite ?? false,
    };

    this.state = {
      phase: "gathering",
      task,
      startTime: new Date(),
    };
  }

  /**
   * Start the workflow
   */
  async start(): Promise<void> {
    // Initialize gatherer
    this.gatherer = createGatherer(this.state.task, {
      maxQuestions: this.config.maxQuestions,
      minConfidence: this.config.minConfidence,
      skipIfClear: this.config.skipGatheringIfClear,
    });

    this.state.gatheringState = this.gatherer.getState();

    // Check if already ready (task was clear enough)
    if (this.gatherer.isReadyForInfinite()) {
      this.state.phase = "confirming";
      this.emitEvent({
        type: "ready",
        refinedTask: this.gatherer.getRefinedTask(),
        confidence: this.gatherer.getConfidence(),
      });

      if (this.config.autoConfirmInfinite) {
        await this.confirmInfinite();
      }
      return;
    }

    // Start asking questions
    const question = this.gatherer.getCurrentQuestion();
    if (question) {
      this.state.currentQuestion = question;
      this.emitEvent({ type: "question", question });
    }
  }

  /**
   * Answer the current question
   */
  answerQuestion(answer: string): void {
    if (!this.gatherer || !this.state.currentQuestion) return;

    this.gatherer.answerQuestion(this.state.currentQuestion.id, answer);
    this.state.gatheringState = this.gatherer.getState();

    this.emitEvent({
      type: "answered",
      questionId: this.state.currentQuestion.id,
      answer,
    });

    // Check if ready
    if (this.gatherer.isReadyForInfinite()) {
      this.state.phase = "confirming";
      this.emitEvent({
        type: "ready",
        refinedTask: this.gatherer.getRefinedTask(),
        confidence: this.gatherer.getConfidence(),
      });

      if (this.config.autoConfirmInfinite) {
        this.confirmInfinite();
      }
      return;
    }

    // Next question
    const nextQuestion = this.gatherer.getCurrentQuestion();
    if (nextQuestion) {
      this.state.currentQuestion = nextQuestion;
      this.emitEvent({ type: "question", question: nextQuestion });
    }
  }

  /**
   * Use default answer for current question
   */
  useDefault(): void {
    if (!this.gatherer || !this.state.currentQuestion) return;
    if (!this.state.currentQuestion.defaultAnswer) return;

    this.answerQuestion(this.state.currentQuestion.defaultAnswer);
  }

  /**
   * Skip remaining questions and proceed
   */
  skipRemaining(): void {
    if (!this.gatherer) return;

    this.gatherer.skipRemaining();
    this.state.gatheringState = this.gatherer.getState();
    this.state.phase = "confirming";

    this.emitEvent({
      type: "ready",
      refinedTask: this.gatherer.getRefinedTask(),
      confidence: this.gatherer.getConfidence(),
    });

    if (this.config.autoConfirmInfinite) {
      this.confirmInfinite();
    }
  }

  /**
   * Confirm and start infinite mode
   */
  async confirmInfinite(): Promise<void> {
    if (!this.gatherer) return;

    this.state.phase = "executing";
    this.emitEvent({ type: "confirmed" });

    const refinedTask = this.gatherer.getRefinedTask();

    this.runner = createInfiniteRunner(refinedTask, {
      ...this.config.infiniteConfig,
      onIteration: (state) => {
        this.state.infiniteState = state;
        this.emitEvent({ type: "progress", state });
      },
    });

    try {
      const finalState = await this.runner.run();
      this.state.infiniteState = finalState;
      this.state.phase = "complete";
      this.state.endTime = new Date();

      this.emitEvent({ type: "complete", state: finalState });
    } catch (err) {
      this.emitEvent({
        type: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  /**
   * Cancel the workflow
   */
  cancel(): void {
    if (this.runner) {
      this.runner.abort();
    }
    this.state.phase = "cancelled";
    this.state.endTime = new Date();
    this.emitEvent({ type: "cancelled" });
  }

  /**
   * Get current state
   */
  getState(): WorkflowState {
    return { ...this.state };
  }

  /**
   * Emit typed event
   */
  private emitEvent(event: WorkflowEvent): void {
    this.emit(event.type, event);
    this.emit("event", event);
  }

  /**
   * Format status for display
   */
  formatStatus(): string {
    switch (this.state.phase) {
      case "gathering":
        if (this.gatherer) {
          return this.gatherer.formatStatus();
        }
        return "Analyzing task...";

      case "confirming":
        const confidence = this.gatherer?.getConfidence() ?? 0;
        return `✅ Ready! Confidence: ${confidence}% | Waiting for confirmation...`;

      case "executing":
        if (this.state.infiniteState) {
          return `🔄 ${formatInfiniteState(this.state.infiniteState)}`;
        }
        return "🔄 Starting infinite mode...";

      case "complete":
        return "✅ Complete!";

      case "cancelled":
        return "❌ Cancelled";

      default:
        return this.state.phase;
    }
  }
}

// ============================================
// Factory Functions
// ============================================

/**
 * Create a proactive-infinite workflow
 */
export function createWorkflow(task: string, config?: WorkflowConfig): ProactiveInfiniteWorkflow {
  return new ProactiveInfiniteWorkflow(task, config);
}

/**
 * Run a complete workflow (for CLI)
 */
export async function runWorkflow(
  task: string,
  config?: WorkflowConfig,
  callbacks?: {
    onQuestion?: (q: ClarifyingQuestion) => Promise<string>;
    onReady?: (refinedTask: string, confidence: number) => Promise<boolean>;
    onProgress?: (state: InfiniteState) => void;
  }
): Promise<InfiniteState | null> {
  const workflow = createWorkflow(task, config);

  return new Promise((resolve, reject) => {
    workflow.on("question", async (event: { type: "question"; question: ClarifyingQuestion }) => {
      if (callbacks?.onQuestion) {
        const answer = await callbacks.onQuestion(event.question);
        workflow.answerQuestion(answer);
      } else {
        // Use default or skip
        workflow.useDefault();
      }
    });

    workflow.on("ready", async (event: { type: "ready"; refinedTask: string; confidence: number }) => {
      if (callbacks?.onReady) {
        const confirmed = await callbacks.onReady(event.refinedTask, event.confidence);
        if (confirmed) {
          workflow.confirmInfinite();
        } else {
          workflow.cancel();
        }
      } else {
        // Auto-confirm
        workflow.confirmInfinite();
      }
    });

    workflow.on("progress", (event: { type: "progress"; state: InfiniteState }) => {
      callbacks?.onProgress?.(event.state);
    });

    workflow.on("complete", (event: { type: "complete"; state: InfiniteState }) => {
      resolve(event.state);
    });

    workflow.on("cancelled", () => {
      resolve(null);
    });

    workflow.on("error", (event: { type: "error"; error: Error }) => {
      reject(event.error);
    });

    workflow.start();
  });
}

// ============================================
// Prompt Templates for Agent Integration
// ============================================

export const PROACTIVE_SYSTEM_ADDITION = `
## PROACTIVE QUESTIONING MODE

Before executing complex tasks, you should PROACTIVELY ask clarifying questions.
This makes your execution MORE DETERMINISTIC and MORE SUCCESSFUL.

When you receive a vague task:
1. Identify what information you're missing
2. Ask 2-3 targeted questions
3. Wait for answers
4. Once confident, say: "I have everything I need. Ready for infinite mode?"

Example questions:
- "Which framework should I use - Next.js or plain React?"
- "What's the primary color scheme - dark mode or light?"
- "Are there any specific features that are must-haves?"

DO NOT start execution until you have sufficient clarity.
The goal is to gather ALL needed context BEFORE autonomous execution.
`;

export const INFINITE_OFFER_PROMPT = `
I now have all the information I need to complete this task:

{{REFINED_TASK}}

My confidence level is {{CONFIDENCE}}%.

Would you like me to enable **INFINITE MODE**?
- I will work autonomously until the task is complete
- No questions, no interruptions
- Errors will be automatically recovered
- I'll validate success before stopping

Type "yes" or "/infinite" to proceed, or provide more details if needed.
`;

// ============================================
// Exports
// ============================================

export default {
  ProactiveInfiniteWorkflow,
  createWorkflow,
  runWorkflow,
  PROACTIVE_SYSTEM_ADDITION,
  INFINITE_OFFER_PROMPT,
};
