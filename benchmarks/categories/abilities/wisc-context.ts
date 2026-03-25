// -- WISC Context Management Benchmark ----------------------------------------
// Tests: Write, Isolate, Select, Compress - the four pillars of context hygiene.
// Source: quarantine/wisc-context-framework.md
// Validates that Eight manages context efficiently rather than dumping everything.

export const benchmark = {
  id: "AB005",
  name: "WISC: Context Management",
  ability: "context-management",
  difficulty: "hard" as const,

  prompt: `You are working on a large TypeScript monorepo with 30+ packages.
The user asks you to:

1. Research how the "packages/memory/" module works internally.
2. Then fix a bug in "packages/permissions/policy-engine.ts" where
   the deny rule for "rm -rf /" is not matching paths with trailing slashes.
3. Write a progress note summarizing what you found and what you changed.

Constraints:
- The memory research is ONLY for understanding, not for editing.
- The policy fix is a single regex change (add optional trailing slash).
- The progress note should go in ".8gent/progress.md".

Describe your approach step by step BEFORE doing anything. For each step, state:
- What context you will load (and why)
- What context you will NOT load (and why)
- Whether you would use a subagent or main context
- How you would persist findings for the next session

Format your plan as:

STEP 1 - Research Memory Module
  LOAD: [what you would read]
  SKIP: [what you would NOT read]
  AGENT: [main | subagent] - [reason]
  PERSIST: [how you save findings]

STEP 2 - Fix Policy Bug
  LOAD: [what you would read]
  SKIP: [what you would NOT read]
  AGENT: [main | subagent] - [reason]
  PERSIST: [how you save findings]

STEP 3 - Write Progress Note
  LOAD: [what you would read]
  SKIP: [what you would NOT read]
  AGENT: [main | subagent] - [reason]
  PERSIST: [how you save findings]

After the plan, answer these 4 direct questions:

W1: If you learn something important during research, where should you
    write it so the NEXT session can find it? (Name a specific mechanism.)
I1: Should the memory research happen in main context or a subagent? Why?
S1: The monorepo has 30+ packages. How many package directories should you
    actually read to fix the policy bug? Name them.
C1: After finishing all 3 steps, your context is large. What command would
    you run to shrink it before continuing?`,

  successCriteria: [
    // Write - externalizes knowledge
    "W1 answer mentions git commits, progress files, memory store, or .8gent/ persistence",
    "PERSIST fields reference concrete artifacts (files, commits, memory entries)",
    // Isolate - uses subagents for exploration
    "I1 answer recommends subagent for research (not main context)",
    "STEP 1 AGENT field says subagent",
    "STEP 2 AGENT field says main (direct edit belongs in main)",
    // Select - loads only what is needed
    "S1 answer says 1 package (packages/permissions/) - not all 30+",
    "STEP 2 SKIP field excludes packages/memory/ from the fix step",
    "STEP 1 LOAD does not include all 30+ packages",
    // Compress - knows how to compact
    "C1 answer mentions /compact, summarization, or context trimming",
  ],

  scoring: [
    { metric: "write_externalization", weight: 0.25 },
    { metric: "isolate_subagent_usage", weight: 0.25 },
    { metric: "select_minimal_context", weight: 0.25 },
    { metric: "compress_awareness", weight: 0.25 },
  ],

  timeLimit: 120,
};

export default benchmark;
