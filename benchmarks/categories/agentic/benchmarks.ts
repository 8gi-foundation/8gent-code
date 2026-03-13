import type { BenchmarkDefinition } from "../../types";

export const agenticBenchmarks: BenchmarkDefinition[] = [
  // ── Tool Creation ─────────────────────────────────────────────────
  {
    id: "TC001",
    category: "agentic",
    title: "Config Parser — Lexer, Parser, Validator, Serializer with AST Roundtrip",
    difficulty: "hard",
    prompt: `Build a parser for a Dockerfile-like config language called ".agentfile".

## Requirements

Implement 4 files:

### lexer.ts
Tokenizer that handles:
- Simple directives: \`FROM node:20\`, \`RUN apt-get update\`, \`PORT 3000\`
- String values (quoted and unquoted)
- Comments starting with \`#\`
- Heredoc blocks: \`SCRIPT <<EOF\\n...\\nEOF\`
- Variable interpolation: \`\${VAR}\` and \`\${VAR:-default}\`

Export a \`lex(input: string): Token[]\` function (or \`tokenize\`).

### parser.ts
Recursive descent parser producing a typed AST. Node types:
- **Directive**: key-value pair (e.g., \`FROM node:20\`)
- **Block**: named block with children (e.g., \`SERVICE api { ... }\`)
- **Conditional**: \`@if condition { ... } @else { ... }\`
- **Comment**: preserved in AST for roundtrip

Export a \`parse(input: string): AST\` function. The AST should have a \`body\` or \`nodes\` array.

### validator.ts
Validates an AST and returns errors:
- Duplicate keys in the same block scope
- Unknown/invalid directive names (optional — be lenient)
- Unresolved variable references (optional)

Export a \`validate(ast: AST): { errors: ValidationError[] }\` function.

### serializer.ts
Renders an AST back to source text. The output, when re-parsed, must produce a structurally equivalent AST (roundtrip fidelity).

Export a \`serialize(ast: AST): string\` function.

## Key Constraints
- Roundtrip: \`parse(serialize(parse(input)))\` must produce equivalent ASTs
- Handle nested blocks (at least 3 levels deep)
- Handle heredoc values (\`<<EOF ... EOF\`)
- Handle variable interpolation with defaults (\`\${VAR:-default}\`)
- Empty input → empty AST, no crash
- Comments-only input → valid AST`,
    keywords: [
      "Lexer", "Parser", "AST", "Token", "serialize", "parse", "validate",
      "Directive", "Block", "heredoc", "interpolation", "recursive",
      "node", "children", "comment", "tokenize",
    ],
    keywordThreshold: 8,
    testExecution: true,
    testFile: "autoresearch/tests/TC001-config-parser.test.ts",
    multiFile: true,
    timeoutMs: 15000,
  },

  // ── Data Pipeline ─────────────────────────────────────────────────
  {
    id: "DP001",
    category: "agentic",
    title: "ETL Data Pipeline — CSV Parse, Transform, Join, Aggregate",
    difficulty: "hard",
    prompt: `Build an ETL pipeline that processes messy CSV data from three sources: customers, orders, and products.

## Requirements

Implement 4 files:

### parser.ts
CSV parser that handles:
- Quoted fields with embedded commas: \`"Alice, Jr."\`
- BOM markers (\\uFEFF at start of file)
- Mixed line endings (CRLF and LF)
- Escaped quotes in values
- Malformed rows (wrong column count) — skip with error, don't crash

Export a \`parseCSV(input: string): Array<Record<string, string>>\` function that returns rows as objects with header keys.

### transforms.ts
Data transformation functions:
- \`deduplicateCustomers(rows)\`: Group by email, keep most recent record, merge non-null fields
- \`normalizeDates(value)\`: Convert various formats to ISO (YYYY-MM-DD): "01/20/2024", "January 15, 2024", "15 Mar 2024", "2024-01-15"
- \`parseCurrency(value)\`: Convert "$1,234.56", "24.50 USD", "1.234,56" (European) to numeric cents or dollars
- \`validateReferences(orders, customers, products)\`: Drop orders referencing non-existent customer/product IDs

### pipeline.ts
Main orchestrator. Export a \`runPipeline(customersCSV: string, ordersCSV: string, productsCSV: string)\` function that:
1. Parses all three CSVs
2. Validates and cleans customers (dedup, normalize dates, validate emails)
3. Validates and cleans orders (normalize dates, parse currency, check references)
4. Computes revenue per customer (sum of valid order totals per customer)
5. Returns: \`{ customers, orders, revenue, report }\`

Drop invalid records (no email, invalid dates, bad references) — collect errors, never throw.

### report.ts
Quality report generator showing: rows processed, rows dropped, dedup merges, normalization fixes, integrity violations.

## Fixture Data
The pipeline receives three CSV strings. The data has realistic issues:
- Duplicate customers (same email, different IDs)
- Missing fields, invalid emails
- Currency in different formats ($, EUR, European decimals)
- Date in 4+ formats
- Orders referencing non-existent customers/products
- Malformed CSV rows

The pipeline must handle ALL of these gracefully without crashing.`,
    keywords: [
      "parse", "CSV", "transform", "deduplicate", "normalize", "join",
      "aggregate", "revenue", "quality", "report", "BOM", "ISO",
      "referential", "integrity", "malformed", "currency",
    ],
    keywordThreshold: 8,
    testExecution: true,
    testFile: "autoresearch/tests/DP001-etl-pipeline.test.ts",
    multiFile: true,
    fixtures: ["fixtures/etl-data.ts"],
    timeoutMs: 15000,
  },

  // ── Reverse Engineering ───────────────────────────────────────────
  {
    id: "RE001",
    category: "agentic",
    title: "Algorithm Reverse Engineering — Deduce Transform from I/O Pairs",
    difficulty: "hard",
    prompt: `You are given 15 input/output pairs from an unknown function that transforms arrays of integers. Study the pairs carefully, deduce the algorithm, and implement it.

## Training Pairs

The pairs will be loaded from a fixture. Your function must match ALL of them, PLUS 5 held-out pairs you haven't seen.

Import the training pairs: \`import { TRAINING_PAIRS } from "./re-pairs"\`

Study them carefully. The algorithm involves:
- Processing consecutive sequences of numbers
- Different handling for ascending runs, descending runs, and repeated values (plateaus)
- Encoding the results into a flat output array

## Requirements

Create a single file \`solution.ts\` that exports:
\`\`\`typescript
export function transform(input: number[]): number[]
export default transform;
\`\`\`

Your implementation must:
1. Correctly reproduce all 15 training pair outputs
2. Generalize to unseen inputs (5 held-out test cases)
3. Handle edge cases: empty array, single element, all same values
4. Process an array of 10,000 elements in under 100ms`,
    keywords: [
      "transform", "function", "export", "default", "number",
      "array", "ascending", "descending", "plateau", "consecutive",
    ],
    keywordThreshold: 5,
    testExecution: true,
    testFile: "autoresearch/tests/RE001-reverse-engineering.test.ts",
    multiFile: false,
    fixtures: ["fixtures/re-pairs.ts"],
    timeoutMs: 15000,
  },

  // ── Systems Debugging ─────────────────────────────────────────────
  {
    id: "SD001",
    category: "agentic",
    title: "Multi-Bug Systems Debugging — Find & Fix 3 Subtle Bugs",
    difficulty: "hard",
    prompt: `You are given a 4-file event-driven message broker system. It has 3 subtle bugs that need fixing. Find them and fix them WITHOUT breaking existing functionality.

## The System

### types.ts — Shared types (no bugs)
Contains Message, Subscription, Topic, BrokerOptions, HistoryOptions interfaces.

### broker.ts — Message broker with pub/sub
Handles topic subscriptions, message publishing, and delivery.
Contract: subscribe() and unsubscribe() must be safe to call concurrently on the same topic.

### history.ts — Message history store
Stores message history per topic with configurable maxHistory.
Contract: the internal storage for each topic should NEVER exceed maxHistory entries.

### router.ts — Topic pattern matching with wildcards
Matches topic patterns like "user.*" against topic names.
Contract: The wildcard "*" matches ZERO or more characters (not one or more).

## Your Task
1. Read all 4 files carefully
2. Identify the 3 bugs (one per file — types.ts has no bugs)
3. Fix the bugs
4. Output ALL 4 files (even types.ts — copy it unchanged)

## Hints
- Bug 1 (broker.ts): Think about what happens when two async operations modify the same subscriber list simultaneously
- Bug 2 (history.ts): The returned history looks correct, but check what accumulates internally
- Bug 3 (router.ts): Test the edge case of "user.*" matching "user." (empty suffix after the dot)

Import fixture files using relative imports: \`import { ... } from "./types"\`

The files live in your working directory. Read them from: fixtures/broker-system/`,
    keywords: [
      "subscribe", "unsubscribe", "publish", "wildcard", "pattern",
      "history", "maxHistory", "prune", "concurrent", "lock",
      "mutex", "broker", "message", "topic", "match",
    ],
    keywordThreshold: 8,
    testExecution: true,
    testFile: "autoresearch/tests/SD001-systems-debugging.test.ts",
    multiFile: true,
    fixtures: [
      "fixtures/broker-system/types.ts",
      "fixtures/broker-system/broker.ts",
      "fixtures/broker-system/history.ts",
      "fixtures/broker-system/router.ts",
    ],
    timeoutMs: 20000,
  },

  // ── Architecture ──────────────────────────────────────────────────
  {
    id: "AR001",
    category: "agentic",
    title: "Plugin System — Dependency Resolution, Lifecycle, Hot-Reload",
    difficulty: "hard",
    prompt: `Build a plugin system with dependency resolution, lifecycle management, and hot-reload capability.

## Requirements

Implement 4 files:

### types.ts
Define interfaces:
- \`Plugin\`: name, version, dependencies (string[]), optionalDependencies (string[]), provides (string[]), lifecycle hooks (init, start, stop, destroy — all async)
- \`PluginManifest\`: metadata about a registered plugin
- \`LoadState\`: enum/type for "unloaded" | "loading" | "loaded" | "started" | "stopped" | "error"

### resolver.ts
Dependency resolver:
- Topological sort (Kahn's algorithm or DFS)
- Circular dependency detection — throw descriptive error naming the cycle
- Handle optional vs required dependencies
- Map "provides" capabilities to plugins that satisfy "requires"

Export: \`resolve(plugins: PluginManifest[]): string[]\` (ordered load list)

### registry.ts
Plugin registry:
- \`register(plugin)\`: Add plugin, throw on duplicate name
- \`getLoadOrder()\`: Return dependency-resolved order
- \`getPlugin(name)\`: Return registered plugin

### manager.ts
Plugin manager — the main orchestrator:
- \`register(plugin)\`: Delegate to registry
- \`initAll()\`: Initialize all plugins in dependency order (call init hooks)
- \`startAll()\`: Start all plugins in dependency order (call start hooks)
- \`stopAll()\`: Stop all plugins in REVERSE dependency order (call stop hooks)
- \`getPlugin(name)\`: Lazy loading — if plugin not yet initialized, init it and its deps first
- \`reload(name)\`: Hot-reload — re-init the named plugin AND all plugins that depend on it (cascade)

## Key Behaviors
- Diamond dependency (A→B,C; B→D; C→D): D loads once, before B and C
- Circular deps (A→B→C→A): throws with cycle info
- Optional deps: if missing, plugin still loads (dep is null)
- Stop order is reverse of start order
- Lazy loading: getPlugin() triggers init chain on demand
- Hot-reload cascade: reloading D re-inits B, C, A (its dependents)
- Stop is idempotent (safe to call twice)`,
    keywords: [
      "Plugin", "register", "resolve", "topological", "cycle", "circular",
      "dependency", "lifecycle", "init", "start", "stop", "destroy",
      "lazy", "reload", "cascade", "provides", "requires", "manifest",
    ],
    keywordThreshold: 10,
    testExecution: true,
    testFile: "autoresearch/tests/AR001-plugin-system.test.ts",
    multiFile: true,
    timeoutMs: 15000,
  },

  // ── Creative Scripting ────────────────────────────────────────────
  {
    id: "CB001",
    category: "agentic",
    title: "Git Repository Analyzer — Traverse, Extract Stats, Report",
    difficulty: "hard",
    prompt: `Build a TypeScript module that analyzes git repositories in a directory tree using a mock filesystem.

## Requirements

Implement 2 files:

### analyzer.ts
Core analysis logic. Export an \`analyze(fs: MockFileSystem, rootPath: string)\` function that:

1. Traverses the directory tree starting at rootPath
2. Finds all directories containing a \`.git\` subdirectory (these are git repos)
3. SKIPS nested git repos (submodules) — if a .git dir is found inside another repo's tree, skip the inner one
4. For each repo, extracts:
   - Total commit count (parse git log output from \`fs.gitLog()\`)
   - Unique authors (parse "Author: Name <email>" from git log)
   - Language breakdown (file extensions and their counts)
   - Largest file (by size from \`fs.stat()\`)
   - Current branch (from \`fs.readFile(".git/HEAD")\` — handle detached HEAD)
5. Returns an array of repo analysis objects

### reporter.ts
Export a \`generateReport(analysis)\` function that:
1. Formats the analysis into a structured JSON report
2. Sorts repos by total commits descending
3. Includes a summary section

## MockFileSystem API (provided — import from fixture)
\`\`\`typescript
import { MockFileSystem } from "./mock-git";

class MockFileSystem {
  async readdir(path: string): Promise<MockDirEntry[]>  // { name, isDirectory }
  async stat(path: string): Promise<MockStat>            // { isDirectory, isFile, size }
  async readFile(path: string): Promise<string>           // file contents
  async gitLog(repoPath: string): Promise<string>         // git log output
}
\`\`\`

## Key Edge Cases
- Empty repos (no commits): return 0 commits, don't crash
- Detached HEAD: .git/HEAD contains a hash, not "ref: refs/heads/..."
- Nested git repos (submodules): skip the inner one
- Handle git log format: \`commit HASH\\nAuthor: Name <email>\\nDate: date\\n\\n    message\``,
    keywords: [
      "traverse", "git", "repository", "commit", "author", "stats",
      "language", "extension", "submodule", "detached", "HEAD",
      "report", "JSON", "analyze", "MockFileSystem", "readdir",
    ],
    keywordThreshold: 8,
    testExecution: true,
    testFile: "autoresearch/tests/CB001-git-analyzer.test.ts",
    multiFile: true,
    fixtures: ["fixtures/mock-git.ts"],
    timeoutMs: 15000,
  },

  // ── Constraint Solver ─────────────────────────────────────────────
  {
    id: "MR001",
    category: "agentic",
    title: "CSP Constraint Solver — Sudoku + Scheduling with AC-3",
    difficulty: "hard",
    prompt: `Implement a general-purpose constraint satisfaction problem (CSP) solver, then use it to solve Sudoku puzzles and scheduling problems.

## Requirements

Implement 4 files:

### csp.ts
Generic CSP solver with:
- \`Variable\`: name + domain (set of possible values)
- \`Constraint\`: scope (variable names) + predicate function
- \`solve(variables, constraints)\`: Returns assignment or null
- **AC-3** preprocessing: propagate arc consistency to prune domains before search
- **Backtracking** with Most-Constrained-Variable (MCV) heuristic: pick variable with smallest remaining domain
- **Forward checking**: after assigning a variable, prune inconsistent values from neighbors' domains

Export: \`CSPSolver\` class or \`solve\` function.

### sudoku.ts
Sudoku encoder/decoder:
- \`solveSudoku(grid: number[][]): number[][] | null\`
- Takes 9x9 grid (0 = empty cell)
- Creates CSP variables (81 cells, domain 1-9 for empty, fixed for given)
- Creates constraints (row, column, 3x3 box uniqueness)
- Solves via CSP solver
- Returns completed grid or null if unsolvable

### scheduler.ts
Interval scheduling encoder:
- \`solveSchedule(tasks, resources): Assignment[] | null\`
- Tasks: \`{ id, duration, earliest, latest }\` (time window)
- Resources: number of available parallel resources
- Creates CSP: variable per task (domain = valid start times), constraints for non-overlap on same resource
- Returns assignment: \`{ taskId, startTime, resource }\` or null if impossible

### utils.ts
Shared utilities: domain copying, constraint graph building, solution validation.

## Key Algorithms
- **AC-3**: Maintain a queue of arcs. For each arc (Xi, Xj), remove values from Xi's domain that have no consistent value in Xj. If domain changes, re-enqueue all arcs pointing to Xi.
- **MCV**: When choosing next variable to assign, pick the one with fewest remaining values in its domain.
- **Forward Checking**: After assigning Xi=v, for each unassigned neighbor Xj, remove values from Xj's domain that conflict with Xi=v.

## Performance Requirements
- Easy Sudoku (30 givens): < 500ms
- Hard Sudoku (17 givens): < 2000ms
- 15-task scheduling: < 5000ms
- Impossible puzzles must return null quickly, not hang`,
    keywords: [
      "CSP", "Variable", "Constraint", "domain", "backtrack", "AC-3",
      "arc", "consistency", "MCV", "forward", "checking", "Sudoku",
      "schedule", "solve", "prune", "propagate", "queue",
    ],
    keywordThreshold: 9,
    testExecution: true,
    testFile: "autoresearch/tests/MR001-constraint-solver.test.ts",
    multiFile: true,
    timeoutMs: 30000,
  },
];
