import type { BenchmarkDefinition } from "../../types";

/**
 * Long-Horizon Benchmarks — Tasks requiring 500+ lines, multi-step reasoning,
 * custom tool creation, and real-world architectural decisions.
 *
 * These are the hardest benchmarks in the suite. They simulate tasks that
 * take senior engineers 4-8 hours and test end-to-end system design.
 */

export const longHorizonBenchmarks: BenchmarkDefinition[] = [

  // ── LH001: Build a Full Code Review Bot ────────────────────────────
  {
    id: "LH001",
    category: "long-horizon" as any,
    title: "GitHub PR Review Bot — AST diff, style checks, security scan, comment generation",
    difficulty: "hard",
    prompt: `Build a complete GitHub PR code review system in TypeScript (NO external deps).

## Files to Create

### diff-parser.ts
Parse unified diff format into structured data:
- \`parseDiff(raw: string): FileDiff[]\`
- FileDiff: { path: string; oldPath?: string; status: "added" | "modified" | "deleted" | "renamed"; hunks: Hunk[] }
- Hunk: { oldStart: number; oldCount: number; newStart: number; newCount: number; changes: Change[] }
- Change: { type: "add" | "delete" | "context"; content: string; lineNumber: number }
- Handle: binary files (skip), rename detection (\`rename from/to\`), mode changes, no-newline-at-eof

### ast-analyzer.ts
Analyze TypeScript/JavaScript code changes:
- \`analyzeChanges(before: string, after: string): ChangeAnalysis\`
- ChangeAnalysis: { functionsAdded: string[]; functionsRemoved: string[]; functionsModified: string[]; complexityDelta: number; linesAdded: number; linesRemoved: number }
- Complexity: count if/else/for/while/switch/catch/&&/|| operators (McCabe-style)
- Function detection: \`function name\`, \`const name = (\`, \`name(\`, class methods
- \`calculateComplexity(code: string): number\`

### security-scanner.ts
Detect common vulnerabilities in code:
- \`scanCode(code: string, filePath: string): SecurityIssue[]\`
- SecurityIssue: { severity: "critical" | "high" | "medium" | "low"; rule: string; line: number; message: string; snippet: string }
- Rules:
  1. SQL injection: string concat in query (template literals with \${} near SELECT/INSERT/UPDATE/DELETE)
  2. XSS: innerHTML, document.write, dangerouslySetInnerHTML
  3. Hardcoded secrets: password=, secret=, api_key=, token= followed by string literal
  4. Eval usage: eval(, new Function(
  5. Insecure crypto: MD5, SHA1 used for passwords
  6. Path traversal: \`../\` in file operations (readFile, writeFile near user input)
  7. Command injection: exec(, execSync( with template literals
  8. Prototype pollution: __proto__, constructor.prototype assignment

### style-checker.ts
Enforce coding conventions:
- \`checkStyle(code: string, config?: StyleConfig): StyleViolation[]\`
- StyleConfig: { maxLineLength?: number; maxFunctionLength?: number; maxComplexity?: number; requireTypes?: boolean; noAny?: boolean; noConsoleLog?: boolean }
- StyleViolation: { rule: string; line: number; message: string; fixable: boolean }
- Default config: maxLineLength=120, maxFunctionLength=50, maxComplexity=10, noConsoleLog=true
- Detect: lines too long, functions too long, \`any\` type usage, console.log in production code, TODO/FIXME comments, empty catch blocks

### review-generator.ts
Generate structured review comments:
- \`generateReview(diffs: FileDiff[], options?: ReviewOptions): ReviewReport\`
- ReviewOptions: { securityScan?: boolean; styleCheck?: boolean; complexityCheck?: boolean }
- ReviewReport: { summary: string; files: FileReview[]; overallScore: number; blockers: number; warnings: number; suggestions: number }
- FileReview: { path: string; comments: ReviewComment[]; score: number }
- ReviewComment: { line: number; type: "blocker" | "warning" | "suggestion" | "praise"; body: string; rule?: string }
- Score 0-100 per file: -20 per blocker, -5 per warning, +2 per praise
- Overall score: weighted average of file scores
- Summary must include: files reviewed, total comments, blocker count, top concern

## Key Constraints
- Must handle edge cases: empty diffs, binary files, very large files (>1000 lines)
- Security scanner must not false-positive on variable names (e.g. \`const password = getInput()\`)
- Style checker must respect config overrides
- Review score must clamp to 0-100 range`,
    keywords: [
      "parseDiff", "FileDiff", "Hunk", "Change",
      "analyzeChanges", "ChangeAnalysis", "complexity",
      "scanCode", "SecurityIssue", "severity", "critical",
      "SQL injection", "XSS", "eval", "hardcoded",
      "checkStyle", "StyleViolation", "maxLineLength",
      "generateReview", "ReviewReport", "ReviewComment",
      "blocker", "warning", "suggestion", "praise",
      "export", "class", "interface",
    ],
    keywordThreshold: 18,
    testExecution: true,
    testFile: "categories/long-horizon/tests/LH001-review-bot.test.ts",
    multiFile: true,
    timeoutMs: 30000,
  },

  // ── LH002: Build a Database Migration Engine ──────────────────────
  {
    id: "LH002",
    category: "long-horizon" as any,
    title: "Database Migration Engine — Schema diff, up/down, rollback, dry-run, dependency graph",
    difficulty: "hard",
    prompt: `Build a complete database migration engine in TypeScript (NO external deps).

## Files to Create

### schema.ts
Schema representation and diffing:
- \`interface Column { name: string; type: string; nullable: boolean; defaultValue?: string; primaryKey?: boolean; unique?: boolean; references?: { table: string; column: string } }\`
- \`interface Table { name: string; columns: Column[]; indexes: Index[]; constraints: Constraint[] }\`
- \`interface Index { name: string; columns: string[]; unique: boolean }\`
- \`interface Constraint { name: string; type: "foreign_key" | "check" | "unique"; definition: string }\`
- \`interface Schema { tables: Table[]; version: number }\`
- \`diffSchemas(from: Schema, to: Schema): SchemaDiff\` — returns { tablesAdded, tablesRemoved, tablesModified }
- Each modified table: { columnsAdded, columnsRemoved, columnsModified, indexesAdded, indexesRemoved }
- \`generateSQL(diff: SchemaDiff): { up: string[]; down: string[] }\` — DDL statements for both directions

### migration.ts
Migration file management:
- \`interface Migration { id: string; name: string; timestamp: number; up: string[]; down: string[]; checksum: string; dependencies?: string[] }\`
- \`class MigrationManager\`
- \`register(migration: Migration): void\` — validates no duplicate IDs
- \`getExecutionOrder(): Migration[]\` — topological sort by dependencies, then by timestamp
- \`getPending(applied: string[]): Migration[]\` — migrations not yet applied, in order
- \`getRollbackPlan(targetId: string, applied: string[]): Migration[]\` — reverse order from current to target
- \`validate(): ValidationResult\` — check for circular deps, missing deps, checksum changes
- ValidationResult: { valid: boolean; errors: string[] }

### executor.ts
Migration execution with safety:
- \`class MigrationExecutor\`
- Constructor: \`(options: { dryRun?: boolean; onProgress?: (step: MigrationStep) => void })\`
- \`async migrate(migrations: Migration[]): Promise<ExecutionResult>\` — run up scripts in order
- \`async rollback(migrations: Migration[]): Promise<ExecutionResult>\` — run down scripts in reverse
- ExecutionResult: { applied: string[]; failed?: { id: string; error: string }; dryRun: boolean; statements: string[] }
- MigrationStep: { migrationId: string; direction: "up" | "down"; statement: string; index: number; total: number }
- On failure: stop execution, report which migration failed
- Dry run: collect statements without executing, return in result
- Lock mechanism: \`acquireLock() / releaseLock()\` to prevent concurrent migrations

### history.ts
Track migration state:
- \`class MigrationHistory\`
- \`record(migrationId: string, direction: "up" | "down", durationMs: number): void\`
- \`getApplied(): string[]\` — ordered list of applied migration IDs
- \`isApplied(id: string): boolean\`
- \`getTimeline(): HistoryEntry[]\` — full history with timestamps
- HistoryEntry: { migrationId: string; direction: "up" | "down"; appliedAt: number; durationMs: number }
- \`getLastApplied(): string | null\`
- Undo support: recording a "down" removes the "up" entry from applied list

## Key Constraints
- Topological sort must detect cycles and throw
- SQL generation must be valid (CREATE TABLE, ALTER TABLE ADD/DROP COLUMN, CREATE INDEX, DROP TABLE)
- Dry run must produce identical statement list to real run
- Rollback plan must not include migrations that weren't applied
- History must be consistent: up adds, down removes from applied list`,
    keywords: [
      "Column", "Table", "Schema", "Index", "Constraint",
      "diffSchemas", "SchemaDiff", "generateSQL",
      "Migration", "MigrationManager", "getExecutionOrder",
      "topological", "dependencies", "getPending", "getRollbackPlan",
      "MigrationExecutor", "dryRun", "migrate", "rollback",
      "ExecutionResult", "acquireLock", "releaseLock",
      "MigrationHistory", "record", "getApplied", "getTimeline",
      "CREATE TABLE", "ALTER TABLE", "DROP", "export",
    ],
    keywordThreshold: 18,
    testExecution: true,
    testFile: "categories/long-horizon/tests/LH002-migration-engine.test.ts",
    multiFile: true,
    timeoutMs: 30000,
  },

  // ── LH003: Build a Distributed Task Scheduler ─────────────────────
  {
    id: "LH003",
    category: "long-horizon" as any,
    title: "Distributed Task Scheduler — Cron parser, priority queue, worker pool, circuit breaker",
    difficulty: "hard",
    prompt: `Build a production-grade task scheduler in TypeScript (NO external deps).

## Files to Create

### cron-parser.ts
Parse cron expressions:
- \`parseCron(expression: string): CronSchedule\`
- CronSchedule: { minute: number[]; hour: number[]; dayOfMonth: number[]; month: number[]; dayOfWeek: number[] }
- Support: *(any), N(exact), N-M(range), */N(step), N,M,O(list), N-M/S(range with step)
- Validate ranges: minute(0-59), hour(0-23), dayOfMonth(1-31), month(1-12), dayOfWeek(0-6)
- \`getNextRun(schedule: CronSchedule, from?: Date): Date\` — next occurrence after \`from\`
- \`getNextNRuns(schedule: CronSchedule, n: number, from?: Date): Date[]\`
- Invalid expression → throw Error with details

### priority-queue.ts
Min-heap priority queue:
- \`class PriorityQueue<T>\`
- \`enqueue(item: T, priority: number): void\` — lower number = higher priority
- \`dequeue(): T | undefined\`
- \`peek(): T | undefined\`
- \`size(): number\`
- \`isEmpty(): boolean\`
- \`toArray(): T[]\` — sorted by priority
- \`remove(predicate: (item: T) => boolean): boolean\` — remove first match
- Must use heap (not sorted array) — O(log n) enqueue/dequeue

### worker-pool.ts
Managed worker pool with concurrency:
- \`class WorkerPool\`
- Constructor: \`(options: { maxWorkers: number; taskTimeout?: number; onTaskComplete?: (result: TaskResult) => void; onTaskError?: (error: TaskError) => void })\`
- \`async submit<T>(task: () => Promise<T>, options?: { priority?: number; id?: string; timeout?: number }): Promise<T>\`
- \`getStats(): PoolStats\` — { activeWorkers, queuedTasks, completedTasks, failedTasks, avgDurationMs }
- \`async drain(): Promise<void>\` — wait for all running + queued tasks
- \`async shutdown(): Promise<void>\` — drain then prevent new submissions
- Per-task timeout via Promise.race
- Rejected after shutdown → throw Error("Pool is shut down")

### circuit-breaker.ts
Protect against cascading failures:
- \`class CircuitBreaker\`
- Constructor: \`(options: { failureThreshold: number; resetTimeoutMs: number; halfOpenMaxAttempts?: number; onStateChange?: (from: State, to: State) => void })\`
- States: "closed" (normal), "open" (failing, reject all), "half-open" (testing recovery)
- \`async execute<T>(fn: () => Promise<T>): Promise<T>\`
- \`getState(): "closed" | "open" | "half-open"\`
- \`getStats(): { failures: number; successes: number; state: string; lastFailure?: number }\`
- \`reset(): void\` — force back to closed
- Closed → Open: when consecutive failures >= threshold
- Open → Half-Open: after resetTimeoutMs elapses
- Half-Open → Closed: on success; Half-Open → Open: on failure
- Open state: throw CircuitOpenError without calling fn

### scheduler.ts
Main scheduler orchestrating everything:
- \`class TaskScheduler\`
- \`schedule(id: string, cronExpression: string, handler: () => Promise<void>, options?: ScheduleOptions): void\`
- ScheduleOptions: { priority?: number; timeout?: number; maxRetries?: number; circuitBreaker?: boolean }
- \`unschedule(id: string): boolean\`
- \`async start(): Promise<void>\` — begin processing scheduled tasks
- \`async stop(): Promise<void>\` — graceful shutdown
- \`getScheduledTasks(): ScheduledTaskInfo[]\`
- \`getNextExecutions(limit?: number): Array<{ taskId: string; nextRun: Date }>\`
- Uses WorkerPool for execution, PriorityQueue for ordering, CircuitBreaker per task
- Tick interval: check every second which tasks are due

## Key Constraints
- Cron parser must handle all standard cron features including ranges, steps, and lists
- Priority queue must be a proper heap implementation
- Circuit breaker state transitions must be atomic
- Scheduler must handle tasks due at the same time (all get queued)
- Shutdown must be graceful (finish running, don't start new)`,
    keywords: [
      "parseCron", "CronSchedule", "getNextRun", "getNextNRuns",
      "PriorityQueue", "enqueue", "dequeue", "heap",
      "WorkerPool", "submit", "drain", "shutdown", "maxWorkers",
      "CircuitBreaker", "closed", "open", "half-open", "failureThreshold",
      "CircuitOpenError", "execute", "getState", "getStats",
      "TaskScheduler", "schedule", "unschedule", "start", "stop",
      "export", "class", "interface", "async",
    ],
    keywordThreshold: 20,
    testExecution: true,
    testFile: "categories/long-horizon/tests/LH003-scheduler.test.ts",
    multiFile: true,
    timeoutMs: 30000,
  },

  // ── LH004: Full-Stack API Gateway ─────────────────────────────────
  {
    id: "LH004",
    category: "long-horizon" as any,
    title: "API Gateway — Request routing, middleware chain, rate limiting, caching, request transformation",
    difficulty: "hard",
    prompt: `Build a complete API gateway framework in TypeScript (NO external deps).

## Files to Create

### router.ts
Path-based request routing with params:
- \`class Router\`
- \`route(method: string, path: string, handler: Handler): void\`
- \`match(method: string, url: string): RouteMatch | null\`
- RouteMatch: { handler: Handler; params: Record<string, string>; query: Record<string, string> }
- Handler: \`(req: GatewayRequest, res: GatewayResponse) => Promise<void> | void\`
- Path params: \`/users/:id\` matches \`/users/123\` → params.id = "123"
- Wildcard: \`/api/*\` matches \`/api/anything/here\`
- Query parsing: \`/search?q=foo&page=2\` → query = { q: "foo", page: "2" }
- Method matching: case-insensitive (GET, get, Get all match)
- 404: match returns null

### middleware.ts
Composable middleware pipeline:
- \`class MiddlewarePipeline\`
- \`use(middleware: Middleware): void\` — add to pipeline
- \`async execute(req: GatewayRequest, res: GatewayResponse): Promise<void>\`
- Middleware: \`(req: GatewayRequest, res: GatewayResponse, next: () => Promise<void>) => Promise<void>\`
- Middlewares run in order; each must call next() to continue (like Express/Koa)
- If middleware throws, pipeline stops and error is propagated
- If middleware doesn't call next(), remaining middlewares are skipped
- Built-in middlewares:
  - \`corsMiddleware(origins?: string[]): Middleware\` — set CORS headers
  - \`loggingMiddleware(): Middleware\` — log method, path, status, duration
  - \`errorMiddleware(): Middleware\` — catch errors, return 500 with message

### cache.ts
Response caching layer:
- \`class ResponseCache\`
- Constructor: \`(options: { maxSize: number; defaultTTL: number })\`
- \`get(key: string): CachedResponse | null\` — null if expired or missing
- \`set(key: string, response: CachedResponse, ttl?: number): void\` — evict LRU if full
- \`invalidate(pattern: string): number\` — delete matching keys, return count
- \`clear(): void\`
- \`getStats(): { hits: number; misses: number; size: number; hitRate: number }\`
- CachedResponse: { status: number; headers: Record<string, string>; body: string; cachedAt: number; ttl: number }
- \`cacheMiddleware(cache: ResponseCache, options?: { ttl?: number; methods?: string[] }): Middleware\`
  - Only cache GET/HEAD by default
  - Cache key = method + path + sorted query string
  - On hit: set response from cache, skip next()
  - On miss: call next(), then cache the response

### transformer.ts
Request/response transformation:
- \`class RequestTransformer\`
- \`addHeader(name: string, value: string): RequestTransformer\` — chainable
- \`removeHeader(name: string): RequestTransformer\`
- \`rewritePath(from: RegExp, to: string): RequestTransformer\` — regex replace
- \`addQueryParam(key: string, value: string): RequestTransformer\`
- \`apply(req: GatewayRequest): GatewayRequest\` — returns new request with transforms applied
- \`class ResponseTransformer\`
- \`addHeader(name: string, value: string): ResponseTransformer\`
- \`removeHeader(name: string): ResponseTransformer\`
- \`transformBody(fn: (body: string) => string): ResponseTransformer\`
- \`apply(res: GatewayResponse): GatewayResponse\`
- \`transformMiddleware(req: RequestTransformer, res: ResponseTransformer): Middleware\`

### gateway.ts
Main gateway combining everything:
- \`class APIGateway\`
- Constructor: \`(options?: { cache?: ResponseCache; rateLimiter?: RateLimiter })\`
- \`route(method: string, path: string, handler: Handler): void\`
- \`use(middleware: Middleware): void\`
- \`async handleRequest(req: GatewayRequest): Promise<GatewayResponse>\` — main entry point
- GatewayRequest: { method: string; path: string; headers: Record<string, string>; body?: string; query?: Record<string, string> }
- GatewayResponse: { status: number; headers: Record<string, string>; body: string }
- Process: middleware pipeline → router match → handler → response transforms
- 404 if no route matches
- 500 on unhandled error

### rate-limiter.ts (reuse pattern from BT001 but adapted for gateway)
- Token bucket per client key
- \`rateLimitMiddleware(limiter: RateLimiter): Middleware\` — returns 429 when exceeded

## Key Constraints
- Path matching must handle edge cases: trailing slashes, encoded characters
- Middleware chain must support both sync and async middlewares
- Cache must be LRU with proper TTL expiration
- Request transformer must be immutable (return new object)
- Gateway must handle concurrent requests safely`,
    keywords: [
      "Router", "route", "match", "RouteMatch", "params", "query",
      "MiddlewarePipeline", "use", "execute", "next", "Middleware",
      "cors", "logging", "error",
      "ResponseCache", "CachedResponse", "invalidate", "hitRate",
      "cacheMiddleware", "LRU", "TTL",
      "RequestTransformer", "ResponseTransformer", "rewritePath", "addHeader",
      "APIGateway", "handleRequest", "GatewayRequest", "GatewayResponse",
      "rateLimitMiddleware", "429",
      "export", "class", "async",
    ],
    keywordThreshold: 20,
    testExecution: true,
    testFile: "categories/long-horizon/tests/LH004-api-gateway.test.ts",
    multiFile: true,
    timeoutMs: 30000,
  },

  // ── LH005: Build a CLI Framework ──────────────────────────────────
  {
    id: "LH005",
    category: "long-horizon" as any,
    title: "CLI Framework — Arg parser, command registry, help generator, interactive prompts, progress bars",
    difficulty: "hard",
    prompt: `Build a complete CLI framework in TypeScript (NO external deps).

## Files to Create

### arg-parser.ts
Robust argument parser:
- \`parseArgs(argv: string[], definitions: ArgDefinition[]): ParsedArgs\`
- ArgDefinition: { name: string; alias?: string; type: "string" | "number" | "boolean" | "array"; required?: boolean; default?: any; description?: string; choices?: string[] }
- ParsedArgs: { args: Record<string, any>; positionals: string[]; errors: string[] }
- Support: --flag, --key=value, --key value, -f, -k value, -- (stop parsing)
- Boolean flags: --verbose (true), --no-verbose (false)
- Array: --include a --include b → ["a", "b"]
- Validation: required check, type coercion, choices validation
- Unknown flags → add to errors array, don't throw

### command-registry.ts
Command registration and dispatch:
- \`class CommandRegistry\`
- \`register(command: CommandDefinition): void\`
- CommandDefinition: { name: string; description: string; args?: ArgDefinition[]; subcommands?: CommandDefinition[]; handler: (args: ParsedArgs, context: CommandContext) => Promise<void> | void }
- \`async dispatch(argv: string[]): Promise<void>\` — find command, parse args, run handler
- \`getCommand(name: string): CommandDefinition | null\`
- \`listCommands(): CommandDefinition[]\`
- Subcommand support: \`cli project create --name foo\`
- Default command: handler for no command specified
- Unknown command → suggest closest match (Levenshtein distance)

### help-generator.ts
Auto-generate help text:
- \`generateHelp(command: CommandDefinition, programName?: string): string\`
- \`generateCommandList(commands: CommandDefinition[], programName?: string): string\`
- Format:
  \`\`\`
  Usage: program <command> [options]

  Commands:
    create    Create a new project
    list      List all projects

  Options:
    --name, -n    Project name (required)
    --verbose, -v Enable verbose output
  \`\`\`
- Align columns, wrap descriptions at 80 chars
- Show default values: \`[default: "foo"]\`
- Show choices: \`[choices: "a", "b", "c"]\`

### progress.ts
Terminal progress indicators:
- \`class ProgressBar\`
- Constructor: \`(options: { total: number; width?: number; format?: string })\`
- \`update(current: number, tokens?: Record<string, string>): string\` — returns formatted bar string
- \`increment(delta?: number): string\`
- Format tokens: {bar}, {current}, {total}, {percent}, {eta}, {elapsed}, {rate}
- Default format: \`"[{bar}] {percent}% | {current}/{total} | ETA: {eta}"\`
- Bar: \`████████░░░░░░░░\` filled vs empty
- ETA calculation: (total - current) / rate

- \`class Spinner\`
- Constructor: \`(options?: { frames?: string[]; interval?: number })\`
- \`frame(): string\` — returns next animation frame
- Default frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

### formatter.ts
Output formatting utilities:
- \`table(rows: string[][], options?: TableOptions): string\` — aligned columns with borders
- TableOptions: { headers?: string[]; border?: boolean; padding?: number; maxWidth?: number }
- \`colorize(text: string, color: string): string\` — ANSI color codes
- Colors: red, green, yellow, blue, magenta, cyan, white, gray, bold, dim, underline, reset
- \`truncate(text: string, maxWidth: number, suffix?: string): string\`
- \`wordWrap(text: string, width: number): string\`
- \`indent(text: string, spaces: number): string\`
- \`stripAnsi(text: string): string\` — remove ANSI codes for width calculation

## Key Constraints
- Arg parser must handle all edge cases: empty argv, only positionals, mixed flags/positionals
- Command dispatch must support deeply nested subcommands
- Help text must be properly aligned regardless of content length
- Progress bar ETA must smooth jitter (moving average of last 10 updates)
- Table must handle multi-line cells and ANSI color codes in width calculation
- Formatter must handle Unicode characters correctly in width calculation`,
    keywords: [
      "parseArgs", "ArgDefinition", "ParsedArgs", "positionals",
      "CommandRegistry", "register", "dispatch", "CommandDefinition",
      "subcommands", "Levenshtein",
      "generateHelp", "generateCommandList",
      "ProgressBar", "update", "increment", "ETA", "rate",
      "Spinner", "frame",
      "table", "colorize", "ANSI", "truncate", "wordWrap",
      "export", "class", "interface",
    ],
    keywordThreshold: 18,
    testExecution: true,
    testFile: "categories/long-horizon/tests/LH005-cli-framework.test.ts",
    multiFile: true,
    timeoutMs: 30000,
  },
];
