/**
 * 8gent Code - Curriculum Skills
 *
 * Skills as teachable curricula, not just tool instructions.
 * Inspired by Karpathy: "skill is a way to instruct the agent how to teach the thing."
 */

// ============================================
// Types
// ============================================

export interface CurriculumStep {
  id: string;
  title: string;
  /** What the learner should understand after this step */
  objective: string;
  /** Step IDs that must be completed first */
  prerequisites: string[];
  /** The teaching material or prompt */
  content: string;
  /** Things to try */
  exercises: string[];
  /** Question to check comprehension */
  verifyUnderstanding: string;
  estimatedMinutes: number;
}

export interface Curriculum {
  id: string;
  title: string;
  description: string;
  steps: CurriculumStep[];
  targetAudience: string;
  totalEstimatedMinutes: number;
}

// ============================================
// Runner
// ============================================

export class CurriculumRunner {
  private curriculum: Curriculum;
  private currentIndex: number = 0;
  private completedSteps: Set<string> = new Set();

  constructor(curriculum: Curriculum) {
    this.curriculum = curriculum;
  }

  getCurrentStep(): CurriculumStep {
    return this.curriculum.steps[this.currentIndex];
  }

  /**
   * Move to the next step. Returns the new step, or null if complete.
   */
  advance(): CurriculumStep | null {
    this.completedSteps.add(this.curriculum.steps[this.currentIndex].id);
    this.currentIndex++;
    if (this.currentIndex >= this.curriculum.steps.length) {
      return null;
    }
    return this.curriculum.steps[this.currentIndex];
  }

  getProgress(): { completed: number; total: number; percent: number } {
    const total = this.curriculum.steps.length;
    const completed = this.completedSteps.size;
    return {
      completed,
      total,
      percent: total > 0 ? Math.round((completed / total) * 100) : 0,
    };
  }

  /**
   * Jump to a specific step by ID.
   */
  skipTo(stepId: string): CurriculumStep {
    const index = this.curriculum.steps.findIndex((s) => s.id === stepId);
    if (index === -1) {
      throw new Error(`Step "${stepId}" not found in curriculum "${this.curriculum.id}"`);
    }
    // Mark all prior steps as completed
    for (let i = 0; i < index; i++) {
      this.completedSteps.add(this.curriculum.steps[i].id);
    }
    this.currentIndex = index;
    return this.curriculum.steps[index];
  }

  isComplete(): boolean {
    return this.currentIndex >= this.curriculum.steps.length;
  }

  /**
   * Generate the teaching prompt for the current step,
   * including context from the curriculum and progress.
   */
  toPrompt(): string {
    if (this.isComplete()) {
      return `Curriculum "${this.curriculum.title}" is complete. All ${this.curriculum.steps.length} steps finished.`;
    }

    const step = this.getCurrentStep();
    const progress = this.getProgress();
    const prereqNames = step.prerequisites
      .map((id) => {
        const s = this.curriculum.steps.find((x) => x.id === id);
        return s ? s.title : id;
      })
      .join(", ");

    const lines: string[] = [
      `# ${this.curriculum.title}`,
      `> ${this.curriculum.description}`,
      `> Audience: ${this.curriculum.targetAudience}`,
      "",
      `## Step ${this.currentIndex + 1}/${this.curriculum.steps.length}: ${step.title}`,
      `Progress: ${progress.completed}/${progress.total} (${progress.percent}%)`,
      "",
      `### Objective`,
      step.objective,
      "",
    ];

    if (step.prerequisites.length > 0) {
      lines.push(`### Prerequisites`, prereqNames, "");
    }

    lines.push(
      `### Content`,
      step.content,
      "",
      `### Exercises`,
      ...step.exercises.map((e, i) => `${i + 1}. ${e}`),
      "",
      `### Comprehension Check`,
      step.verifyUnderstanding,
    );

    return lines.join("\n");
  }
}

// ============================================
// Built-in Curricula
// ============================================

const EIGHT_ARCHITECTURE: Curriculum = {
  id: "8gent-architecture",
  title: "How Eight Works Internally",
  description: "A deep dive into 8gent-code's architecture, from CLI entry to tool execution.",
  targetAudience: "Developers contributing to or extending 8gent-code",
  totalEstimatedMinutes: 45,
  steps: [
    {
      id: "arch-1-overview",
      title: "System Overview",
      objective: "Understand the high-level architecture: CLI -> agent loop -> tools -> LLM providers.",
      prerequisites: [],
      content: [
        "8gent-code is a monorepo with packages under `packages/`.",
        "The core agent lives in `packages/eight/` — it owns the agentic loop, tool dispatch, and provider abstraction.",
        "`packages/self-autonomy/` handles self-healing, git automation, and evolution tracking.",
        "The CLI entrypoint wires everything together: parsing args, loading SOUL.md, and starting the REPL or single-shot mode.",
        "Key insight: Eight is provider-agnostic. It talks to Ollama, LM Studio, or OpenRouter through a unified `LLMClient` interface.",
      ].join("\n"),
      exercises: [
        "Read `packages/eight/types.ts` and identify the `LLMClient` interface.",
        "Trace the import chain from `packages/eight/index.ts` to see what gets exported.",
        "Find where SOUL.md is loaded and injected as a system prompt.",
      ],
      verifyUnderstanding: "What are the three LLM runtimes Eight supports, and where is the runtime selected?",
      estimatedMinutes: 8,
    },
    {
      id: "arch-2-agent-loop",
      title: "The Agent Loop",
      objective: "Understand how Eight processes a user message: prompt assembly, LLM call, tool dispatch, and iteration.",
      prerequisites: ["arch-1-overview"],
      content: [
        "The agent loop in `agent.ts` follows a standard ReAct pattern:",
        "1. Assemble messages: system prompt (from SOUL.md + context), conversation history, user message.",
        "2. Call the LLM with the current message array and available tools.",
        "3. If the LLM returns tool calls, execute them and append results to history.",
        "4. Repeat until the LLM returns a final text response or maxTurns is hit.",
        "Event callbacks (`AgentEventCallbacks`) fire at each stage for UI integration.",
      ].join("\n"),
      exercises: [
        "Read the main loop in `agent.ts` and count how many times the LLM can be called per user message.",
        "Find where `onToolStart` and `onToolEnd` events are emitted.",
        "Identify what happens when `maxTurns` is exceeded.",
      ],
      verifyUnderstanding: "What stops the agent loop from running forever?",
      estimatedMinutes: 10,
    },
    {
      id: "arch-3-tools",
      title: "Tool System",
      objective: "Understand how tools are defined, registered, and dispatched.",
      prerequisites: ["arch-2-agent-loop"],
      content: [
        "Tools are defined in `tools.ts` as objects with a name, description, parameters schema, and execute function.",
        "The `run()` unified tool pattern (inspired by agent-clip) provides a single CLI-like interface.",
        "Built-in commands: cat, ls, grep, head, tail, wc, sort, uniq, write, tree, echo, pwd.",
        "Tools support Unix pipe/chain syntax: |, &&, ||, ;",
        "Two-layer execution: raw execution produces output, then LLM formats it for presentation.",
      ].join("\n"),
      exercises: [
        "Read `tools.ts` and list all registered tool names.",
        "Write a simple tool that counts files in a directory and register it.",
        "Trace how pipe chains are parsed and executed.",
      ],
      verifyUnderstanding: "Why does Eight use a single `run()` tool instead of many individual tools?",
      estimatedMinutes: 10,
    },
    {
      id: "arch-4-providers",
      title: "LLM Provider Abstraction",
      objective: "Understand how Eight talks to different LLM backends through the same interface.",
      prerequisites: ["arch-2-agent-loop"],
      content: [
        "Each provider (Ollama, LM Studio, OpenRouter) implements the `LLMClient` interface:",
        "- `chat(messages, tools)` — send a conversation with optional tool definitions",
        "- `generate(prompt)` — simple text completion",
        "- `isAvailable()` — health check",
        "Provider selection happens at startup based on config. The agent doesn't know or care which provider is active.",
        "OpenRouter routes through their API and supports model switching. Free models route to Gemini variants.",
      ].join("\n"),
      exercises: [
        "Read the OpenRouter client and find where the API key is loaded.",
        "Compare Ollama and LM Studio clients — what's different in their request format?",
        "Add a mock provider that returns canned responses for testing.",
      ],
      verifyUnderstanding: "If you wanted to add a new LLM provider (e.g., Anthropic direct), what interface methods would you implement?",
      estimatedMinutes: 8,
    },
    {
      id: "arch-5-self-autonomy",
      title: "Self-Autonomy and Evolution",
      objective: "Understand how Eight heals errors, tracks evolution, and learns from sessions.",
      prerequisites: ["arch-3-tools"],
      content: [
        "`packages/self-autonomy/` is Eight's self-improvement engine.",
        "Key subsystems:",
        "- **AutoGit**: Creates task branches, auto-commits, snapshots before risky ops, merges on success.",
        "- **SelfHeal**: Classifies errors (transient/recoverable/fixable/fatal), remembers solutions, retries with backoff.",
        "- **SessionMemory**: Persists working context across restarts (24h TTL).",
        "- **Reflection**: Post-session analysis that extracts patterns from tool usage and errors.",
        "- **LearnedSkills**: Skills discovered during sessions, stored in evolution DB for future retrieval.",
        "The evolution DB (`evolution-db.ts`) uses Bun's built-in SQLite for persistence.",
      ].join("\n"),
      exercises: [
        "Read `SelfHeal.classifyError()` and add a new error pattern classification.",
        "Trigger a transient error and observe the retry-with-backoff behavior.",
        "Call `reflect()` with mock session data and inspect the stored reflection.",
      ],
      verifyUnderstanding: "What's the difference between a 'transient' and 'recoverable' error in Eight's classification?",
      estimatedMinutes: 9,
    },
  ],
};

const WRITING_BENCHMARKS: Curriculum = {
  id: "writing-benchmarks",
  title: "Writing New Benchmarks for 8gent",
  description: "How to create, grade, and iterate on benchmarks for the autoresearch system.",
  targetAudience: "Anyone adding new benchmark categories or individual test cases",
  totalEstimatedMinutes: 30,
  steps: [
    {
      id: "bench-1-anatomy",
      title: "Anatomy of a Benchmark",
      objective: "Understand the structure of a benchmark: prompt, expected output, grading criteria.",
      prerequisites: [],
      content: [
        "Each benchmark is an object with:",
        "- `id`: Short identifier like BF001, FS001, UI001.",
        "- `category`: Which tier it belongs to (bug-fixing, fullstack, agentic, ui-design, battle-test).",
        "- `prompt`: The task description given to the LLM.",
        "- `expectedFiles`: Files the solution should produce.",
        "- `tests`: Array of execution tests (function calls that return pass/fail).",
        "- `difficulty`: easy | medium | hard.",
        "Benchmarks live in `benchmarks/autoresearch/` with fixtures in `benchmarks/fixtures/`.",
      ].join("\n"),
      exercises: [
        "Read an existing benchmark (e.g., BF001) and identify all its fields.",
        "Find the grading logic in `execution-grader.ts` and understand how scores are computed.",
        "List all benchmark categories and count benchmarks per category.",
      ],
      verifyUnderstanding: "What's the difference between a 'test' and a 'fixture' in the benchmark system?",
      estimatedMinutes: 8,
    },
    {
      id: "bench-2-writing",
      title: "Writing a New Benchmark",
      objective: "Be able to create a complete benchmark with prompt, tests, and fixtures.",
      prerequisites: ["bench-1-anatomy"],
      content: [
        "Steps to create a new benchmark:",
        "1. Choose a category and ID (follow the naming convention: CATEGORY_PREFIX + 3-digit number).",
        "2. Write the prompt — be specific about what the LLM should produce. Include file names.",
        "3. Write execution tests — these are functions that run the LLM's output and check correctness.",
        "4. Add fixtures if needed — mock data, databases, or helper code the benchmark depends on.",
        "5. Set difficulty based on: easy (1 file, straightforward), medium (1-2 files, some complexity), hard (multi-file, requires reasoning).",
        "Key principle: Tests should verify BEHAVIOR, not exact string matches. The LLM might format differently but still be correct.",
      ].join("\n"),
      exercises: [
        "Write a simple benchmark that asks the LLM to implement a sorting function.",
        "Write execution tests that verify the sort works on edge cases (empty array, duplicates, negative numbers).",
        "Run your benchmark through the harness and observe the score.",
      ],
      verifyUnderstanding: "Why should benchmark tests verify behavior rather than exact string output?",
      estimatedMinutes: 10,
    },
    {
      id: "bench-3-grading",
      title: "The Grading System",
      objective: "Understand how execution-grader.ts scores benchmarks and how to debug failing tests.",
      prerequisites: ["bench-2-writing"],
      content: [
        "The execution grader (`execution-grader.ts`) works in SWE-bench style:",
        "1. Extract code from the LLM response (handles ```language fences and <!DOCTYPE for HTML).",
        "2. Write extracted files to a temp directory.",
        "3. Run each test function against the extracted code.",
        "4. Score = (passed_tests / total_tests) * 100.",
        "Multi-file extraction is the hardest part — the grader must correctly split files when the LLM produces multiple in one response.",
        "HTML output is special-cased: structural verification checks for CSS properties, DOM elements, and layout constraints.",
      ].join("\n"),
      exercises: [
        "Add a console.log to the grader to see extracted file contents before tests run.",
        "Create a benchmark where the LLM must produce TWO files and verify both are extracted correctly.",
        "Intentionally break a test and observe the grader's error output.",
      ],
      verifyUnderstanding: "What happens when the grader can't extract any files from the LLM response?",
      estimatedMinutes: 7,
    },
    {
      id: "bench-4-iteration",
      title: "Autoresearch and Iteration",
      objective: "Understand how the autoresearch loop uses benchmark results to improve the system prompt.",
      prerequisites: ["bench-3-grading"],
      content: [
        "The autoresearch loop (`autoresearch-loop.ts`) is the feedback mechanism:",
        "1. Run all benchmarks in a category.",
        "2. Collect scores and identify failures.",
        "3. Mutate the system prompt based on failure patterns.",
        "4. Re-run and compare scores.",
        "5. Keep mutations that improve average score, revert those that regress.",
        "Critical issue: mutation interference. A change that fixes one benchmark can break another.",
        "Solution: per-category mutation scoping and deduplication (70% word overlap check).",
        "Token and timing tracking records prompt_tokens, completion_tokens, and durationMs per run.",
      ].join("\n"),
      exercises: [
        "Run the autoresearch loop for one iteration on a small category.",
        "Read `system-prompt.ts` and find the `addMutation()` function.",
        "Observe how few-shot examples in `few-shot.ts` differ per category.",
      ],
      verifyUnderstanding: "What is 'mutation interference' and how does the system mitigate it?",
      estimatedMinutes: 5,
    },
  ],
};

export const BUILTIN_CURRICULA: Record<string, Curriculum> = {
  "8gent-architecture": EIGHT_ARCHITECTURE,
  "writing-benchmarks": WRITING_BENCHMARKS,
};
