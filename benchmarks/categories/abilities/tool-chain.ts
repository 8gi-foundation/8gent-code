// ── Tool Chain Benchmark ─────────────────────────────────────────────────────
// Tests: packages/eight/tools.ts
// Validates multi-tool sequencing, correct tool selection, and failure recovery.

export const benchmark = {
  id: "AB005",
  name: "Tool Chain: Multi-Tool Sequencing",
  ability: "tool-use",
  difficulty: "hard" as const,

  prompt: `This benchmark tests your ability to chain multiple tools correctly,
select the right tool for each sub-task, and recover from tool failures.

Complete all four phases in order. Each phase depends on the previous one.

Phase 1 - File creation via write_file:
  Create a file at /tmp/8gent-bench/inventory.json containing:
  { "tools": ["read_file", "write_file", "run_command", "list_files"], "count": 4 }
  Then use read_file to confirm the file exists and has the correct content.
  Report: "Phase 1 OK: file created and verified."

Phase 2 - Search and transform via run_command:
  Use run_command to count how many .ts files exist under packages/eight/.
  Write the result into /tmp/8gent-bench/file-count.txt as plain text like:
  "ts_file_count: <N>"
  Then use read_file to verify the content was written.
  Report: "Phase 2 OK: counted <N> TypeScript files."

Phase 3 - Failure recovery:
  Attempt to read_file a path that does not exist: /tmp/8gent-bench/nonexistent.txt
  When this fails, do NOT stop. Instead:
  a) Acknowledge the error in your output.
  b) Create /tmp/8gent-bench/nonexistent.txt with content "recovered" using write_file.
  c) Read it again to prove recovery succeeded.
  Report: "Phase 3 OK: recovered from missing file error."

Phase 4 - Tool selection reasoning:
  Without executing anything, explain which tool you would use for each task
  and why. Answer as "T1: <tool> - <reason>", "T2: ...", etc.
  T1: Find all files matching a glob pattern in a directory.
  T2: Check if the working tree has uncommitted changes.
  T3: Execute an arbitrary shell pipeline (e.g. sort | uniq -c).
  T4: Read a specific function from a TypeScript file by symbol name.
  T5: Store a fact for retrieval in a future session.

Output each phase clearly labeled: "Phase 1:", "Phase 2:", "Phase 3:", "Phase 4:".`,

  successCriteria: [
    "Phase 1 uses write_file then read_file to verify the JSON content",
    "inventory.json contains the exact JSON with 4 tools listed",
    "Phase 2 uses run_command to count .ts files under packages/eight/",
    "file-count.txt contains a ts_file_count line with a real number",
    "Phase 3 attempts to read a nonexistent file and gets an error",
    "Phase 3 recovers by creating then re-reading the file",
    "Phase 4 T1 selects list_files (not run_command or read_file)",
    "Phase 4 T2 selects git_status",
    "Phase 4 T3 selects run_command",
    "Phase 4 T4 selects get_symbol or get_outline (AST tools)",
    "Phase 4 T5 selects remember",
    "All four phases completed without giving up on errors",
  ],

  scoring: [
    { metric: "tools_chained_correctly", weight: 0.30 },
    { metric: "correct_tool_selection", weight: 0.25 },
    { metric: "failure_recovery_demonstrated", weight: 0.25 },
    { metric: "reasoning_quality", weight: 0.20 },
  ],

  timeLimit: 120,
};

export default benchmark;
