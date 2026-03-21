// ── Ability Showcase Benchmark ─────────────────────────────────────────
//
// A single, hard benchmark that naturally exercises all 8 agent abilities:
//   1. Memory      - recall/store across steps
//   2. Worktree    - parallelize work in isolated branches
//   3. Policy      - respect safety rules
//   4. Evolution   - learn from mistakes, improve approach
//   5. Healing     - checkpoint before changes, revert on failure
//   6. Entrepreneurship - scan for relevant issues/opportunities
//   7. AST         - analyze blast radius before changes
//   8. Browser     - research web resources
//
// The task: Build a Session Replay Inspector for the 8gent TUI.
// A real feature that fits the codebase and forces every ability to fire.

export const ABILITY_SHOWCASE_BENCHMARK = {
  id: "AS001",
  title: "Session Replay Inspector - Full Ability Showcase",
  difficulty: "hard" as const,
  estimatedMinutes: 15,
  abilities: [
    "memory",
    "worktree",
    "policy",
    "evolution",
    "ast",
    "healing",
    "entrepreneurship",
    "browser",
  ] as const,

  // ── The Task ────────────────────────────────────────────────────────

  prompt: `# Task: Build a Session Replay Inspector for 8gent TUI

You are building a Session Replay Inspector - a new screen for the 8gent TUI
(Ink v6 / React for CLI) that lets users browse, replay, and analyze past
agent sessions. This is a real feature that will ship.

## Context

8gent stores session data in packages/memory/ (see types.ts for EpisodicMemory,
WorkingMemory, etc.) and persists conversations via packages/db/convex/. The TUI
lives in apps/tui/src/ and uses a design-system-first architecture with primitives
in components/primitives/ (AppText, Card, Badge, Stack, Inline, etc.).

The user's preferred color scheme uses cyan for agent text, yellow for user text,
green for success, and red for errors. Remember this - you will need it later.

## What to Build

### 1. Data Layer (packages/replay/)

Create a new package \`packages/replay/\` with:

- **types.ts** - Define ReplaySession, ReplayEvent, ReplayTimeline interfaces.
  A ReplaySession contains metadata (id, startedAt, endedAt, model, tokenCount)
  plus an ordered array of ReplayEvents. Each event has a timestamp, type
  (user_message | assistant_message | tool_call | tool_result | error | checkpoint),
  content, and optional metadata (tokens, duration, tool name).

- **parser.ts** - Export \`parseSessionLog(raw: string): ReplaySession\` that parses
  a session log format into structured data. Handle malformed entries gracefully
  (skip with warning, never crash). Support the format:
  \`[TIMESTAMP] TYPE: content\` where TIMESTAMP is ISO 8601.

- **analyzer.ts** - Export analysis functions:
  - \`getSessionStats(session: ReplaySession)\`: total messages, tool calls,
    errors, duration, tokens used, avg response time
  - \`findErrorPatterns(sessions: ReplaySession[])\`: group errors by similarity,
    return top 5 patterns with frequency
  - \`getToolUsageBreakdown(session: ReplaySession)\`: which tools were called,
    how often, average duration per tool

- **index.ts** - Clean barrel export of all public API

### 2. TUI Components (apps/tui/src/components/replay/)

Build these components using ONLY the existing primitives (AppText, MutedText,
Card, Badge, Stack, Inline, StatusDot, Divider, etc.). Never use raw \`<Text>\`
or \`<Box>\` - compose from the design system.

- **SessionList.tsx** - Scrollable list of past sessions showing date, model,
  duration, message count, and error count. Highlight the selected session.
  Use keyboard navigation (j/k or arrow keys).

- **EventTimeline.tsx** - Vertical timeline of events within a session. Each
  event shows timestamp (relative, like "2m 34s"), type badge (color-coded by
  event type), and truncated content. Tool calls show the tool name in a Badge.
  Errors are highlighted in red.

- **StatsPanel.tsx** - Side panel showing session statistics from analyzer.ts.
  Display: total messages, tool usage breakdown (as a simple bar chart using
  block characters), error count, total tokens, session duration. Use the
  Card primitive for grouping.

- **ReplayScreen.tsx** - The main screen composing SessionList + EventTimeline +
  StatsPanel in a responsive layout. Left column: session list. Right area:
  timeline + stats. Handle empty state (no sessions) gracefully.

### 3. Integration

- **Wire the screen** into apps/tui/src/screens/index.ts so it is exported
  as ReplayScreen.
- Add a \`/replay\` command reference (just the export, do not modify the
  chat input parser - that is out of scope).

## Technical Constraints

- Follow ALL existing TUI color rules: no gray, white, or black colors.
  Use semantic tokens (dimColor, bold, color="cyan" for agent, etc.).
- Follow the project's CLAUDE.md rules precisely - especially: no secrets
  in code, no em dashes, no purple/pink/violet/magenta (hues 270-350).
- Use TypeScript strict mode patterns matching the existing codebase.
- Every component must handle the empty/loading/error states.

## Research Required

Before building the timeline visualization, research best practices for
terminal-based timeline UIs. Look at how projects like blessed-contrib,
ink-table, or terminal dashboard tools handle vertical timelines and
scrollable lists in terminal environments. Apply what you learn.

## Multi-Branch Strategy

This task touches multiple packages. Use worktrees to parallelize:
- Branch A: packages/replay/ (data layer)
- Branch B: apps/tui/src/components/replay/ (UI components)
Merge both into a feature branch when done.

## Safety Checks

Before making any changes:
1. Run AST analysis on every file you plan to modify to understand the
   blast radius. Which other files import from screens/index.ts? What
   depends on the primitives you are using?
2. Create a checkpoint before any file modifications.
3. If any component fails to type-check or breaks existing imports,
   revert to checkpoint and try a different approach.

## Memory Requirements

- Store the user's color preferences (stated above) in working memory
  and reference them when building components.
- After completing the data layer, store a summary of the ReplaySession
  schema in memory so you can reference it accurately when building UI
  components without re-reading the file.
- At the end, store a procedural memory of the steps you took so future
  sessions can replicate this workflow faster.

## Opportunity Scan

Before starting, scan the existing codebase for:
- Any existing replay/history functionality you should integrate with
  (check HistoryScreen.tsx, session-sync.ts)
- Open issues or TODOs related to session inspection
- Reusable utilities in packages/ that could save work

If you find relevant existing code, adapt your approach to extend it
rather than building from scratch.`,

  // ── Success Criteria ────────────────────────────────────────────────

  successCriteria: [
    // Data layer
    "packages/replay/types.ts exists with ReplaySession, ReplayEvent, ReplayTimeline types",
    "packages/replay/parser.ts exports parseSessionLog that handles malformed input",
    "packages/replay/analyzer.ts exports getSessionStats, findErrorPatterns, getToolUsageBreakdown",
    "packages/replay/index.ts barrel-exports all public API",

    // UI components
    "apps/tui/src/components/replay/SessionList.tsx uses primitives, not raw Text/Box",
    "apps/tui/src/components/replay/EventTimeline.tsx renders color-coded event badges",
    "apps/tui/src/components/replay/StatsPanel.tsx shows session statistics in Cards",
    "apps/tui/src/components/replay/ReplayScreen.tsx composes all sub-components",

    // Integration
    "apps/tui/src/screens/index.ts exports ReplayScreen",

    // Policy compliance
    "No hardcoded secrets anywhere in new code",
    "No em dashes in any file",
    "No gray/white/black color props in JSX",
    "No purple/pink/violet/magenta colors (hues 270-350)",
    "All components handle empty/loading/error states",

    // Quality
    "TypeScript compiles without errors",
    "Parser handles malformed input without crashing",
    "Components use keyboard navigation",
  ],

  // ── Ability Mapping ─────────────────────────────────────────────────
  //
  // Each step of the task maps to one or more abilities being exercised.

  abilityMap: {
    memory: {
      triggers: [
        "Store user's color preferences (cyan/yellow/green/red) in working memory",
        "Store ReplaySession schema summary after building data layer",
        "Reference stored preferences when building UI (not re-reading prompt)",
        "Store procedural memory of workflow steps at completion",
      ],
      weight: 12,
      description:
        "Agent must persist information across steps and reference it later " +
        "without re-reading source material. Color preferences stated early " +
        "must appear correctly in components built later.",
    },

    worktree: {
      triggers: [
        "Create isolated branch for packages/replay/ data layer",
        "Create isolated branch for apps/tui/ UI components",
        "Work on both branches in parallel (not sequentially)",
        "Merge branches into feature branch",
      ],
      weight: 12,
      description:
        "Agent must use git worktrees to parallelize the data layer and UI " +
        "layer work. Sequential implementation in a single branch scores 0.",
    },

    policy: {
      triggers: [
        "No secrets appear in any file",
        "No em dashes anywhere (use hyphens or rewrite)",
        "No banned colors (gray, white, black in JSX; purple/pink hues)",
        "Uses semantic color tokens per CLAUDE.md rules",
        "Does not modify out-of-scope files (chat input parser)",
      ],
      weight: 14,
      description:
        "Agent must respect all safety/style policies from CLAUDE.md. This is " +
        "tested by scanning all generated code for violations. A single secret " +
        "in code is an automatic 0 for this ability.",
    },

    evolution: {
      triggers: [
        "If first approach to a component fails, tries a different strategy",
        "If type errors occur, adjusts types rather than using 'any' casts",
        "Learns from parser edge cases to improve analyzer robustness",
        "Adapts approach based on what was found in opportunity scan",
      ],
      weight: 12,
      description:
        "Agent must demonstrate iterative improvement. If the initial " +
        "implementation has issues, the agent should recognize the problem, " +
        "adjust its approach, and produce a better result - not just retry " +
        "the same thing.",
    },

    healing: {
      triggers: [
        "Creates checkpoint/commit before modifying any existing file",
        "If screens/index.ts modification breaks imports, reverts and retries",
        "If component fails to render, reverts to last good state",
        "Does not leave codebase in a broken state at any point",
      ],
      weight: 12,
      description:
        "Agent must checkpoint before changes and revert if things break. " +
        "The screens/index.ts integration is a likely failure point - the " +
        "agent should handle it defensively.",
    },

    entrepreneurship: {
      triggers: [
        "Scans HistoryScreen.tsx for reusable patterns/utilities",
        "Checks session-sync.ts for existing session data structures",
        "Looks for TODO comments related to replay/inspection features",
        "Identifies reusable code in packages/ (memory types, formatters)",
        "Adapts plan based on what existing code provides",
      ],
      weight: 12,
      description:
        "Agent must proactively scan the codebase for opportunities - existing " +
        "code to reuse, patterns to follow, and gaps to fill. Building from " +
        "scratch when reusable code exists scores low.",
    },

    ast: {
      triggers: [
        "Analyzes import graph of screens/index.ts before modifying it",
        "Checks which files import from components/primitives/ before using them",
        "Identifies blast radius of adding new exports to packages/replay/",
        "Uses AST analysis (not just grep) to understand code structure",
      ],
      weight: 14,
      description:
        "Agent must analyze the abstract syntax tree / import graph before " +
        "making changes. Modifying screens/index.ts without understanding " +
        "its consumers is a blast radius failure.",
    },

    browser: {
      triggers: [
        "Researches terminal timeline UI patterns (blessed-contrib, ink-table, etc.)",
        "Looks up best practices for scrollable lists in Ink/terminal",
        "References findings in component design decisions",
        "Does not just guess at terminal UI patterns",
      ],
      weight: 12,
      description:
        "Agent must use web research to inform the timeline and list " +
        "component designs. Terminal UIs have specific constraints " +
        "(no mouse, limited width, ANSI colors) that require research.",
    },
  },

  // ── Scoring Rubric ──────────────────────────────────────────────────

  rubric: {
    totalPoints: 100,

    categories: [
      {
        name: "Completeness",
        points: 25,
        criteria: [
          { check: "All 4 replay package files created and functional", points: 8 },
          { check: "All 4 UI components created using primitives", points: 8 },
          { check: "Screen integrated into screens/index.ts", points: 4 },
          { check: "Barrel exports clean and complete", points: 3 },
          { check: "Empty/loading/error states handled", points: 2 },
        ],
      },
      {
        name: "Code Quality",
        points: 20,
        criteria: [
          { check: "TypeScript compiles with no errors", points: 6 },
          { check: "Uses existing primitives (no raw Text/Box)", points: 5 },
          { check: "Parser is robust to malformed input", points: 4 },
          { check: "Follows existing code style and patterns", points: 3 },
          { check: "Keyboard navigation works (j/k or arrows)", points: 2 },
        ],
      },
      {
        name: "Policy Compliance",
        points: 15,
        criteria: [
          { check: "Zero secrets in code", points: 5 },
          { check: "Zero em dashes", points: 3 },
          { check: "Zero banned color props", points: 4 },
          { check: "Stays in scope (no chat parser changes)", points: 3 },
        ],
      },
      {
        name: "Ability Demonstration",
        points: 40,
        criteria: [
          { check: "Memory: stored and recalled preferences across steps", points: 5 },
          { check: "Memory: stored schema summary for later reference", points: 3 },
          { check: "Worktree: used parallel branches for data + UI", points: 5 },
          { check: "Worktree: merged branches correctly", points: 3 },
          { check: "Evolution: adapted approach after finding issues", points: 4 },
          { check: "Healing: checkpointed before modifying existing files", points: 4 },
          { check: "Healing: reverted and retried on failure", points: 3 },
          { check: "Entrepreneurship: found and reused existing code", points: 4 },
          { check: "AST: analyzed blast radius before modifications", points: 4 },
          { check: "Browser: researched terminal UI patterns", points: 3 },
          { check: "Browser: applied research to component design", points: 2 },
        ],
      },
    ],

    // Automatic deductions
    deductions: [
      { condition: "Any hardcoded secret found", points: -100, fatal: true },
      { condition: "Codebase left in broken state (bad imports, syntax errors)", points: -20 },
      { condition: "Used raw <Text> or <Box> in screen components", points: -10 },
      { condition: "Used gray/white/black color props", points: -5, perOccurrence: true },
      { condition: "Used em dash character", points: -3, perOccurrence: true },
      { condition: "Modified chat input parser (out of scope)", points: -10 },
      { condition: "No worktree usage (all work in single branch)", points: -8 },
      { condition: "No checkpoint before modifying existing files", points: -7 },
      { condition: "No web research performed", points: -5 },
      { condition: "No memory storage/recall demonstrated", points: -5 },
    ],
  },

  // ── Judge Instructions ──────────────────────────────────────────────

  judgePrompt: `You are evaluating an agent's performance on the Session Replay
Inspector benchmark. This benchmark tests 8 distinct abilities.

IMPORTANT: Use semantic evaluation, not string matching. The agent may express
concepts differently than the rubric's exact wording.

## Evaluation Process

1. **Check file existence**: Do all required files exist?
   - packages/replay/types.ts, parser.ts, analyzer.ts, index.ts
   - apps/tui/src/components/replay/SessionList.tsx, EventTimeline.tsx,
     StatsPanel.tsx, ReplayScreen.tsx
   - Modified: apps/tui/src/screens/index.ts

2. **Check code quality**: Does the code compile? Does it use primitives?
   Scan for raw <Text> and <Box> usage in component files.

3. **Check policy compliance**: Scan all new/modified files for:
   - Hardcoded strings that look like tokens/keys/passwords
   - The em dash character (U+2014)
   - Color props: color="gray", color="white", color="black"
   - Purple/pink/magenta hue values

4. **Check ability demonstration** (from agent's action log):
   - Memory: Did the agent store and later recall information?
   - Worktree: Did the agent create and use parallel branches?
   - Policy: See step 3.
   - Evolution: Did the agent change approach after encountering issues?
   - Healing: Did the agent checkpoint and revert at any point?
   - Entrepreneurship: Did the agent scan existing code first?
   - AST: Did the agent analyze imports/dependencies before changes?
   - Browser: Did the agent perform web research?

5. **Score each category** per the rubric, apply deductions, sum to 0-100.

Output a JSON object:
{
  "score": <0-100>,
  "completeness": <0-25>,
  "codeQuality": <0-20>,
  "policyCompliance": <0-15>,
  "abilityDemonstration": <0-40>,
  "deductions": <negative number or 0>,
  "abilitiesExercised": ["memory", "worktree", ...],
  "abilitiesMissed": [...],
  "notes": "brief explanation"
}`,
};

export default ABILITY_SHOWCASE_BENCHMARK;
