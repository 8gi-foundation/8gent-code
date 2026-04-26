import type { BenchmarkDefinition } from "../../types";

/**
 * Battle Test Benchmarks — $10K Real-World Freelance Contracts
 *
 * Each benchmark represents a genuine production task worth $1K-$3K.
 * Tests code quality, architecture, completeness, and speed.
 * Designed to separate Claude Code from 8gent from raw free models.
 */

export const battleTestBenchmarks: BenchmarkDefinition[] = [
	// ── BT001: SaaS Auth System ($3K value) ──────────────────────────
	{
		id: "BT001",
		category: "battle-test",
		title: "SaaS Auth System — JWT, Roles, Rate Limiting, Password Reset",
		difficulty: "hard",
		prompt: `Build a complete authentication system for a SaaS product.

## Requirements

Implement these files:

### auth.ts
Core authentication module:
- \`hashPassword(password: string): Promise<string>\` — bcrypt-style hashing (use crypto.subtle or built-in)
- \`verifyPassword(password: string, hash: string): Promise<boolean>\`
- \`generateToken(payload: { userId: string; role: Role; email: string }, secret: string, expiresIn?: number): string\` — JWT-like token (base64 encoded JSON with signature)
- \`verifyToken(token: string, secret: string): TokenPayload | null\` — returns null if expired or invalid
- \`generateRefreshToken(): string\` — random 64-char hex string
- \`generateResetCode(): string\` — 6-digit numeric code

Token format: \`base64(header).base64(payload).hmacSignature\`
Payload must include \`exp\` (expiry timestamp), \`iat\` (issued at), \`userId\`, \`role\`, \`email\`.

### rbac.ts
Role-based access control:
- Roles: \`admin\`, \`editor\`, \`viewer\`, \`billing\`
- Type: \`type Role = "admin" | "editor" | "viewer" | "billing"\`
- \`type Permission = "read" | "write" | "delete" | "manage_users" | "manage_billing" | "view_analytics"\`
- \`hasPermission(role: Role, permission: Permission): boolean\`
- \`canAccessResource(role: Role, resource: string, action: "read" | "write" | "delete"): boolean\`
- Admin has all permissions
- Editor: read, write, view_analytics
- Viewer: read only
- Billing: read, manage_billing, view_analytics

### rate-limiter.ts
Token bucket rate limiter:
- \`class RateLimiter\` with constructor \`(maxRequests: number, windowMs: number)\`
- \`check(key: string): { allowed: boolean; remaining: number; resetAt: number }\`
- \`reset(key: string): void\`
- Tracks per-key (e.g. per IP or per user)
- Window-based: resets after windowMs
- Must handle concurrent calls correctly

### user-store.ts
In-memory user store:
- \`class UserStore\`
- \`async createUser(email: string, password: string, role?: Role): Promise<User>\` — hashes password, generates ID
- \`async findByEmail(email: string): Promise<User | null>\`
- \`async findById(id: string): Promise<User | null>\`
- \`async updatePassword(userId: string, newPassword: string): Promise<void>\`
- \`async setResetCode(userId: string): Promise<string>\` — generates and stores reset code
- \`async verifyResetCode(userId: string, code: string): Promise<boolean>\`
- Duplicate email → throw Error("Email already exists")

Interface User: { id: string; email: string; passwordHash: string; role: Role; createdAt: number; resetCode?: string; resetCodeExpiry?: number }

## Key Constraints
- No external dependencies — use built-in crypto only
- Token expiry must work (default 1 hour = 3600000ms)
- Rate limiter must be time-based, not counter-based
- Password hashing must be async (use PBKDF2 or similar)
- All functions must be properly exported`,
		keywords: [
			"hashPassword",
			"verifyPassword",
			"generateToken",
			"verifyToken",
			"Role",
			"Permission",
			"hasPermission",
			"RateLimiter",
			"UserStore",
			"createUser",
			"findByEmail",
			"resetCode",
			"admin",
			"editor",
			"viewer",
			"billing",
			"JWT",
			"hmac",
			"base64",
			"crypto",
			"export",
		],
		keywordThreshold: 12,
		testExecution: true,
		testFile: "categories/battle-test/tests/BT001-auth.test.ts",
		multiFile: true,
		timeoutMs: 15000,
	},

	// ── BT002: Real-Time Event System ($2K value) ────────────────────
	{
		id: "BT002",
		category: "battle-test",
		title: "Event-Driven Architecture — Pub/Sub, Dead Letter Queue, Retry, Backpressure",
		difficulty: "hard",
		prompt: `Build a production-grade event system for microservice communication.

## Requirements

### event-bus.ts
Core event bus with typed events:
- \`class EventBus\`
- \`on<T>(event: string, handler: (data: T) => Promise<void> | void, options?: { priority?: number; filter?: (data: T) => boolean }): () => void\` — returns unsubscribe function
- \`emit<T>(event: string, data: T): Promise<EmitResult>\` — returns { delivered: number, failed: number, errors: Error[] }
- \`once<T>(event: string, handler: (data: T) => Promise<void> | void): () => void\`
- \`off(event: string, handler?: Function): void\` — remove specific handler or all handlers for event
- \`listenerCount(event: string): number\`
- \`eventNames(): string[]\`
- Handlers with higher \`priority\` execute first (default 0)
- \`filter\` option: handler only called if filter returns true

### retry-handler.ts
Exponential backoff retry logic:
- \`class RetryHandler\`
- Constructor: \`(options: { maxRetries: number; baseDelayMs: number; maxDelayMs: number; backoffMultiplier?: number })\`
- \`async execute<T>(fn: () => Promise<T>): Promise<T>\` — retries on failure with exponential backoff
- \`getAttemptCount(): number\`
- Delay formula: \`min(baseDelay * multiplier^attempt, maxDelay)\` + random jitter (±10%)
- After maxRetries exceeded → throw RetryExhaustedError with attempt history

### dead-letter-queue.ts
Failed event storage and replay:
- \`class DeadLetterQueue\`
- \`enqueue(event: string, data: unknown, error: Error, metadata?: Record<string, unknown>): string\` — returns entry ID
- \`dequeue(): DLQEntry | null\` — FIFO
- \`peek(): DLQEntry | null\`
- \`retry(id: string): Promise<boolean>\` — re-emits the event (needs EventBus reference)
- \`retryAll(): Promise<{ succeeded: number; failed: number }>\`
- \`size(): number\`
- \`list(limit?: number): DLQEntry[]\`
- \`purge(olderThanMs?: number): number\` — remove old entries, return count removed

DLQEntry: { id: string; event: string; data: unknown; error: string; timestamp: number; attempts: number; metadata?: Record<string, unknown> }

### backpressure.ts
Flow control for high-throughput scenarios:
- \`class BackpressureController\`
- Constructor: \`(options: { maxConcurrent: number; maxQueueSize: number; timeout?: number })\`
- \`async acquire(): Promise<void>\` — blocks if at capacity, throws if queue full
- \`release(): void\`
- \`async run<T>(fn: () => Promise<T>): Promise<T>\` — acquire → run → release (in finally)
- \`getStats(): { running: number; queued: number; maxConcurrent: number; maxQueue: number }\`
- Queue overflow → throw BackpressureError("Queue full")
- Timeout → throw BackpressureError("Timeout waiting for slot")

## Key Constraints
- All async operations must be properly awaited
- Priority ordering must be stable (same priority = insertion order)
- Retry jitter must be random (not deterministic)
- DLQ entries must track attempt count across retries
- Backpressure must use promises for queue (not polling)
- Export everything: classes, types, errors`,
		keywords: [
			"EventBus",
			"on",
			"emit",
			"once",
			"off",
			"priority",
			"filter",
			"RetryHandler",
			"execute",
			"backoff",
			"jitter",
			"maxRetries",
			"DeadLetterQueue",
			"enqueue",
			"dequeue",
			"retry",
			"purge",
			"BackpressureController",
			"acquire",
			"release",
			"concurrent",
			"Promise",
			"async",
			"await",
			"export",
		],
		keywordThreshold: 14,
		testExecution: true,
		testFile: "categories/battle-test/tests/BT002-events.test.ts",
		multiFile: true,
		timeoutMs: 15000,
	},

	// ── BT003: Data Pipeline with Transforms ($1.5K value) ──────────
	{
		id: "BT003",
		category: "battle-test",
		title: "Data Pipeline — Stream Processing, Schema Validation, Transform Chain",
		difficulty: "hard",
		prompt: `Build a typed data pipeline system for ETL-style processing.

## Requirements

### pipeline.ts
Composable pipeline builder:
- \`class Pipeline<TIn, TOut>\`
- \`static from<T>(source: Iterable<T> | AsyncIterable<T> | T[]): Pipeline<T, T>\`
- \`.map<U>(fn: (item: TOut) => U | Promise<U>): Pipeline<TIn, U>\`
- \`.filter(fn: (item: TOut) => boolean): Pipeline<TIn, TOut>\`
- \`.flatMap<U>(fn: (item: TOut) => U[] | Promise<U[]>): Pipeline<TIn, U>\`
- \`.batch(size: number): Pipeline<TIn, TOut[]>\` — group into batches of N
- \`.tap(fn: (item: TOut) => void): Pipeline<TIn, TOut>\` — side effect, passes through
- \`.take(n: number): Pipeline<TIn, TOut>\` — only first N items
- \`.skip(n: number): Pipeline<TIn, TOut>\` — skip first N items
- \`.collect(): Promise<TOut[]>\` — execute pipeline, return results
- \`.reduce<U>(fn: (acc: U, item: TOut) => U, initial: U): Promise<U>\`
- \`.count(): Promise<number>\`

### schema.ts
Runtime type validation:
- \`const S = { string: () => StringSchema, number: () => NumberSchema, boolean: () => BooleanSchema, object: <T>(shape: T) => ObjectSchema<T>, array: <T>(item: T) => ArraySchema<T>, optional: <T>(schema: T) => OptionalSchema<T> }\`
- Each schema has \`.validate(value: unknown): { valid: boolean; errors: string[] }\`
- \`StringSchema\` has \`.min(n)\`, \`.max(n)\`, \`.pattern(regex)\`, \`.email()\`
- \`NumberSchema\` has \`.min(n)\`, \`.max(n)\`, \`.integer()\`, \`.positive()\`
- \`ObjectSchema\` validates shape recursively
- \`ArraySchema\` validates each element
- Return detailed error paths: "field.nested.0.name: must be a string"

### transforms.ts
Common data transformations:
- \`function deduplicate<T>(items: T[], key?: (item: T) => unknown): T[]\`
- \`function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]>\`
- \`function sortBy<T>(items: T[], key: (item: T) => number | string, order?: "asc" | "desc"): T[]\`
- \`function pivot<T>(items: T[], rowKey: string, colKey: string, valueKey: string): Record<string, Record<string, unknown>>\`
- \`function flatten<T>(nested: (T | T[])[]): T[]\`
- \`function chunk<T>(items: T[], size: number): T[][]\`
- \`function zip<A, B>(a: A[], b: B[]): [A, B][]\`

## Key Constraints
- Pipeline must be lazy (operations only run on collect/reduce/count)
- Pipeline must handle async map/flatMap
- Schema validation must return ALL errors, not just the first
- Error paths must use dot notation for nested objects
- Transforms must not mutate input arrays
- Export all classes, functions, and the S schema builder`,
		keywords: [
			"Pipeline",
			"from",
			"map",
			"filter",
			"flatMap",
			"batch",
			"collect",
			"reduce",
			"take",
			"skip",
			"tap",
			"Schema",
			"validate",
			"string",
			"number",
			"object",
			"array",
			"min",
			"max",
			"pattern",
			"email",
			"integer",
			"positive",
			"deduplicate",
			"groupBy",
			"sortBy",
			"pivot",
			"flatten",
			"chunk",
			"zip",
			"Promise",
			"async",
			"export",
		],
		keywordThreshold: 16,
		testExecution: true,
		testFile: "categories/battle-test/tests/BT003-pipeline.test.ts",
		multiFile: true,
		timeoutMs: 15000,
	},

	// ── BT004: CLI Framework ($1K value) ─────────────────────────────
	{
		id: "BT004",
		category: "battle-test",
		title: "CLI Framework — Command Parser, Help Generator, Flag System, Subcommands",
		difficulty: "hard",
		prompt: `Build a CLI framework similar to Commander.js or yargs — from scratch.

## Requirements

### cli.ts
Main CLI builder:
- \`class CLI\`
- \`constructor(name: string, version?: string)\`
- \`.command(name: string, description: string): Command\` — returns a Command builder
- \`.parse(argv: string[]): ParseResult\` — parse argv and route to command
- \`.help(): string\` — generate help text
- \`.version(): string\`

### command.ts
Command builder with fluent API:
- \`class Command\`
- \`.argument(name: string, description: string, options?: { required?: boolean; default?: unknown }): Command\`
- \`.option(flag: string, description: string, options?: { required?: boolean; default?: unknown; type?: "string" | "number" | "boolean" }): Command\`
- \`.alias(name: string): Command\`
- \`.action(fn: (args: Record<string, unknown>, opts: Record<string, unknown>) => void | Promise<void>): Command\`
- \`.help(): string\` — command-specific help
- \`.subcommand(name: string, description: string): Command\` — nested subcommands

### parser.ts
Argument/flag parser:
- \`function parseArgs(argv: string[], command: Command): ParseResult\`
- Supports: \`--flag value\`, \`--flag=value\`, \`-f value\`, \`-f=value\`
- Boolean flags: \`--verbose\` (no value = true), \`--no-verbose\` (negation = false)
- Remaining args after \`--\` are collected as \`rest\`
- Unknown flags → error
- Missing required args → error
- Type coercion: "42" → 42 for number type, "true"/"false" for boolean

ParseResult: { command: string; args: Record<string, unknown>; options: Record<string, unknown>; rest: string[]; errors: string[] }

### help.ts
Auto-generated help text:
- \`function generateHelp(cli: CLI): string\`
- \`function generateCommandHelp(command: Command): string\`
- Format: aligned columns, usage line, description, options table
- Must show: command name, description, arguments, options with defaults, aliases
- Example output:
\`\`\`
myapp v1.0.0

Usage: myapp <command> [options]

Commands:
  init <name>          Initialize a new project
  build                Build the project
  deploy [env]         Deploy to environment

Options:
  --help, -h           Show help
  --version, -v        Show version
  --verbose            Enable verbose output
\`\`\`

## Key Constraints
- Fluent API: methods must return \`this\` for chaining
- Subcommands must work recursively (myapp git commit --message "foo")
- Boolean negation: \`--no-X\` must set X to false
- Help must be auto-generated from registered commands
- Type coercion must happen automatically based on option type
- Export all classes and functions`,
		keywords: [
			"CLI",
			"Command",
			"command",
			"parse",
			"parseArgs",
			"argument",
			"option",
			"flag",
			"alias",
			"action",
			"subcommand",
			"help",
			"generateHelp",
			"usage",
			"version",
			"boolean",
			"negation",
			"coercion",
			"required",
			"default",
			"fluent",
			"chaining",
			"export",
		],
		keywordThreshold: 12,
		testExecution: true,
		testFile: "categories/battle-test/tests/BT004-cli.test.ts",
		multiFile: true,
		timeoutMs: 15000,
	},

	// ── BT005: State Machine Engine ($1.5K value) ────────────────────
	{
		id: "BT005",
		category: "battle-test",
		title: "State Machine — Typed Transitions, Guards, Actions, Nested States",
		difficulty: "hard",
		prompt: `Build a state machine engine inspired by XState — from scratch.

## Requirements

### machine.ts
State machine definition and execution:
- \`function createMachine<TContext>(config: MachineConfig<TContext>): Machine<TContext>\`
- \`class Machine<TContext>\`
  - \`.transition(state: string, event: string, context?: TContext): TransitionResult<TContext>\`
  - \`.getInitialState(): string\`
  - \`.getStates(): string[]\`
  - \`.getEvents(state: string): string[]\`
  - \`.matches(state: string, pattern: string): boolean\` — supports dot notation for nested states

MachineConfig: { id: string; initial: string; context?: TContext; states: Record<string, StateConfig<TContext>> }

StateConfig: { on?: Record<string, TransitionConfig<TContext> | string>; entry?: Action<TContext>[]; exit?: Action<TContext>[]; initial?: string; states?: Record<string, StateConfig<TContext>> }

TransitionConfig: { target: string; guard?: (context: TContext, event: any) => boolean; actions?: Action<TContext>[] }

TransitionResult: { value: string; context: TContext; changed: boolean; actions: ActionResult[] }

### interpreter.ts
Running machine instance:
- \`class Interpreter<TContext>\`
- Constructor: \`(machine: Machine<TContext>)\`
- \`.start(): Interpreter<TContext>\` — initialize to initial state, run entry actions
- \`.send(event: string, payload?: unknown): TransitionResult<TContext>\`
- \`.getState(): string\`
- \`.getContext(): TContext\`
- \`.subscribe(fn: (state: string, context: TContext) => void): () => void\` — returns unsubscribe
- \`.stop(): void\` — run exit actions for current state
- \`.matches(pattern: string): boolean\`

### guards.ts
Transition guard utilities:
- \`function and<T>(...guards: Guard<T>[]): Guard<T>\` — all must pass
- \`function or<T>(...guards: Guard<T>[]): Guard<T>\` — any must pass
- \`function not<T>(guard: Guard<T>): Guard<T>\` — invert
- \`function equals<T>(key: keyof T, value: unknown): Guard<T>\` — context[key] === value
- \`function greaterThan<T>(key: keyof T, value: number): Guard<T>\`

Guard<T> = (context: T, event: any) => boolean

### actions.ts
Side effect actions:
- \`function assign<T>(updates: Partial<T> | ((context: T, event: any) => Partial<T>)): Action<T>\`
- \`function log<T>(message: string | ((context: T) => string)): Action<T>\`
- \`function raise<T>(event: string): Action<T>\` — queues internal event
- \`function choose<T>(branches: { guard: Guard<T>; actions: Action<T>[] }[]): Action<T>\`

Action<T> = { type: string; exec: (context: T, event: any) => T | void }

## Key Constraints
- Guards must be evaluated BEFORE transition occurs
- Entry/exit actions must fire in correct order: exit old → transition actions → entry new
- Nested states: "parent.child" dot notation for state values
- \`assign\` must return a NEW context object (immutable update)
- Subscribers must be notified after each transition
- Export everything: createMachine, Interpreter, guards, actions`,
		keywords: [
			"createMachine",
			"Machine",
			"Interpreter",
			"transition",
			"guard",
			"action",
			"assign",
			"entry",
			"exit",
			"subscribe",
			"send",
			"getState",
			"getContext",
			"and",
			"or",
			"not",
			"equals",
			"greaterThan",
			"log",
			"raise",
			"choose",
			"nested",
			"initial",
			"context",
			"export",
		],
		keywordThreshold: 14,
		testExecution: true,
		testFile: "categories/battle-test/tests/BT005-state-machine.test.ts",
		multiFile: true,
		timeoutMs: 15000,
	},

	// ── BT006: Financial Analysis Dashboard ($2K value) ──────────────
	{
		id: "BT006",
		category: "battle-test",
		title: "Financial Analysis Dashboard — ROI, NPV, IRR, EBITDA, Ratios",
		difficulty: "hard",
		prompt: `Build financial analysis tools for a CFO dashboard.

## Requirements

### models.ts
TypeScript interfaces for financial data:
- \`interface FinancialStatement { companyName: string; period: string; currency: string; balanceSheet: BalanceSheet; incomeStatement: IncomeStatement; cashFlow: CashFlow }\`
- \`interface BalanceSheet { totalAssets: number; currentAssets: number; totalLiabilities: number; currentLiabilities: number; shareholdersEquity: number; cash: number; inventory: number; accountsReceivable: number; accountsPayable: number; longTermDebt: number }\`
- \`interface IncomeStatement { revenue: number; costOfGoodsSold: number; grossProfit: number; operatingExpenses: number; operatingIncome: number; interestExpense: number; taxExpense: number; netIncome: number; depreciation: number; amortization: number }\`
- \`interface CashFlow { operatingCashFlow: number; investingCashFlow: number; financingCashFlow: number; netCashFlow: number; capitalExpenditures: number; freeCashFlow: number }\`
- \`interface Ratio { name: string; value: number; benchmark?: number; status: "good" | "warning" | "critical" }\`

Export all interfaces.

### calculator.ts
Financial calculation functions:
- \`calculateROI(gain: number, cost: number): number\` — (gain - cost) / cost, returns decimal (0.25 = 25%)
- \`calculateNPV(cashFlows: number[], discountRate: number): number\` — Net Present Value. cashFlows[0] is initial investment (negative). Formula: sum of cashFlows[t] / (1 + rate)^t for t=0..n
- \`calculateIRR(cashFlows: number[], tolerance?: number, maxIterations?: number): number\` — Internal Rate of Return using bisection method. Find rate where NPV = 0. Search range -0.5 to 10.0. Default tolerance 0.0001, maxIterations 1000. Return decimal.
- \`calculateDebtToEquity(totalLiabilities: number, shareholdersEquity: number): number\`
- \`calculateCurrentRatio(currentAssets: number, currentLiabilities: number): number\`
- \`calculateGrossMargin(revenue: number, costOfGoodsSold: number): number\` — returns decimal
- \`calculateNetMargin(netIncome: number, revenue: number): number\` — returns decimal
- \`calculateEBITDA(operatingIncome: number, depreciation: number, amortization: number): number\`
- \`analyzeFinancials(statement: FinancialStatement): Ratio[]\` — calculates ALL above ratios using statement data, returns array of Ratio objects. Set status based on: current ratio < 1 = critical, 1-1.5 = warning, >1.5 = good. Debt-to-equity > 2 = critical, 1-2 = warning, < 1 = good. Margins: < 0 = critical, 0-0.1 = warning, > 0.1 = good.

Export all functions.

### formatter.ts
Display formatting:
- \`formatCurrency(value: number, currency?: string): string\` — default USD. Returns "$1,234.56" format with comma separators and 2 decimal places. Negative values: "($1,234.56)"
- \`formatPercentage(value: number, decimals?: number): string\` — value is decimal (0.25 → "25.00%"). Default 2 decimal places.
- \`formatFinancialReport(statement: FinancialStatement, ratios: Ratio[]): string\` — returns structured markdown string with:
  - Company name and period header
  - Balance Sheet section with key figures
  - Income Statement section
  - Cash Flow section
  - Key Ratios table with name, value, benchmark, status
  - Overall assessment paragraph

Export all functions.

## Key Constraints
- IRR bisection must converge within tolerance
- NPV must handle negative initial investment correctly
- Currency formatting must handle negatives, large numbers, zero
- All ratio calculations must handle division by zero (return 0 or Infinity as appropriate)
- analyzeFinancials must return at least 7 ratios
- Export everything`,
		keywords: [
			"ROI",
			"NPV",
			"IRR",
			"EBITDA",
			"BalanceSheet",
			"IncomeStatement",
			"CashFlow",
			"FinancialStatement",
			"Ratio",
			"calculateROI",
			"calculateNPV",
			"calculateIRR",
			"calculateDebtToEquity",
			"calculateCurrentRatio",
			"calculateGrossMargin",
			"calculateNetMargin",
			"calculateEBITDA",
			"analyzeFinancials",
			"formatCurrency",
			"formatPercentage",
			"formatFinancialReport",
			"debt-to-equity",
			"gross margin",
			"net margin",
			"current ratio",
			"balance sheet",
			"cash flow",
			"discount rate",
			"export",
		],
		keywordThreshold: 14,
		testExecution: true,
		testFile: "categories/battle-test/tests/BT006-financial.test.ts",
		multiFile: true,
		fixtures: [],
		timeoutMs: 30000,
	},

	// ── BT007: SEO Audit Engine ($1.5K value) ────────────────────────
	{
		id: "BT007",
		category: "battle-test",
		title: "SEO Audit Engine — Meta Analysis, Scoring, Core Web Vitals, Reporting",
		difficulty: "hard",
		prompt: `Build an SEO audit engine that analyzes web pages and generates actionable reports.

## Requirements

### analyzer.ts
HTML and content analysis functions:
- \`analyzeMeta(html: string): MetaAnalysis\` — parse an HTML string and extract:
  - \`title: string | null\` — content of <title> tag
  - \`description: string | null\` — content of <meta name="description">
  - \`h1s: string[]\` — text content of all <h1> tags
  - \`h2s: string[]\` — text content of all <h2> tags
  - \`imagesWithoutAlt: number\` — count of <img> tags missing alt attribute
  - \`canonical: string | null\` — href of <link rel="canonical">
  - \`robots: string | null\` — content of <meta name="robots">
  Use regex-based parsing (no DOM library needed).

- \`analyzeContent(text: string): ContentAnalysis\` — analyze plain text content:
  - \`wordCount: number\`
  - \`readingLevel: number\` — Flesch-Kincaid grade level. Formula: 0.39 * (totalWords / totalSentences) + 11.8 * (totalSyllables / totalWords) - 15.59. Count sentences by splitting on .!? followed by space or end. Estimate syllables: count vowel groups (a,e,i,o,u) in each word, minimum 1 per word.
  - \`keywordDensity: (keyword: string) => number\` — returns percentage (0-100) of how often keyword appears relative to total words. Case-insensitive.

- \`analyzeLinks(links: { url: string; text: string; rel?: string }[]): LinkAnalysis\` —
  - \`internal: number\` — links with relative URLs or same-domain
  - \`external: number\` — links with absolute URLs to other domains
  - \`nofollow: number\` — links where rel contains "nofollow"
  - \`emptyText: number\` — links with empty or whitespace-only text

Export all functions and interfaces (MetaAnalysis, ContentAnalysis, LinkAnalysis).

### scorer.ts
Scoring functions — each returns \`{ score: number; issues: string[]; recommendations: string[] }\` where score is 0-100:
- \`scoreMeta(meta: MetaAnalysis): ScoreResult\` — Deduct points: no title (-30), title too long >60 chars (-10), no description (-20), description too long >160 chars (-10), no h1 (-15), multiple h1s (-10), images without alt (-5 each, max -20), no canonical (-5). Add issues/recommendations for each deduction.
- \`scoreContent(content: ContentAnalysis): ScoreResult\` — word count < 300 (-30), < 600 (-15). Reading level > 12 (-20), > 16 (-10). Score starts at 100.
- \`scoreLinks(links: LinkAnalysis): ScoreResult\` — no internal links (-20), too many nofollow > 50% (-15), empty link text (-10 each, max -30).
- \`scorePerformance(metrics: { lcp: number; fid: number; cls: number }): ScoreResult\` — Core Web Vitals scoring. LCP: <2.5s = good, 2.5-4s = warning (-20), >4s = poor (-40). FID: <100ms = good, 100-300ms = warning (-20), >300ms = poor (-40). CLS: <0.1 = good, 0.1-0.25 = warning (-15), >0.25 = poor (-30).
- \`overallScore(scores: ScoreResult[]): number\` — weighted average. Weights: meta 30%, content 25%, links 20%, performance 25%.

Export all functions and the ScoreResult interface.

### reporter.ts
Report generation:
- \`interface AuditReport { url: string; timestamp: number; overallGrade: string; overallScore: number; summary: string; sections: AuditSection[] }\`
- \`interface AuditSection { name: string; score: number; grade: string; issues: string[]; recommendations: string[] }\`
- \`generateAuditReport(url: string, scores: { meta: ScoreResult; content: ScoreResult; links: ScoreResult; performance: ScoreResult }): AuditReport\`
  - Grade mapping: 90-100 = "A", 80-89 = "B", 70-79 = "C", 60-69 = "D", <60 = "F"
  - Summary: 1-2 sentence overview mentioning grade and top issues
  - Each score becomes a section with its name, score, grade, issues, recommendations

Export all functions and interfaces.

## Key Constraints
- Regex-based HTML parsing (no external DOM libraries)
- Flesch-Kincaid must use the standard formula
- All scores clamped to 0-100 range
- Grade must follow standard A-F scale
- keywordDensity must be a function on the returned object
- Export everything`,
		keywords: [
			"analyzeMeta",
			"analyzeContent",
			"analyzeLinks",
			"scoreMeta",
			"scoreContent",
			"scoreLinks",
			"scorePerformance",
			"overallScore",
			"generateAuditReport",
			"AuditReport",
			"AuditSection",
			"ScoreResult",
			"meta",
			"title tag",
			"description",
			"h1",
			"alt text",
			"canonical",
			"keyword density",
			"Flesch-Kincaid",
			"Core Web Vitals",
			"LCP",
			"FID",
			"CLS",
			"internal links",
			"nofollow",
			"audit grade",
			"export",
		],
		keywordThreshold: 13,
		testExecution: true,
		testFile: "categories/battle-test/tests/BT007-seo.test.ts",
		multiFile: true,
		fixtures: [],
		timeoutMs: 30000,
	},

	// ── BT008: Email Campaign System ($1K value) ─────────────────────
	{
		id: "BT008",
		category: "battle-test",
		title: "Email Campaign System — Templates, Personalization, A/B Testing, Analytics",
		difficulty: "hard",
		prompt: `Build an email campaign system with templating, personalization, and analytics tracking.

## Requirements

### template.ts
Email template engine:
- \`class Template\`
  - \`constructor(name: string, subject: string, body: string)\`
  - \`render(vars: Record<string, string>): string\` — replaces all \`{{varName}}\` placeholders in both subject and body with values from vars. Unknown placeholders remain as-is. Returns the rendered body.
  - \`renderSubject(vars: Record<string, string>): string\` — same replacement logic but returns rendered subject.
  - \`validate(): { valid: boolean; missingVars: string[] }\` — scans body and subject for \`{{var}}\` placeholders and returns list of all variable names found (these are "required"). Always valid at template level — missingVars is informational.
  - \`addSection(name: string, content: string): void\` — appends named section to body. Format: "\\n<!-- section: name -->\\ncontent\\n<!-- /section: name -->\\n"
  - \`toHTML(): string\` — wraps rendered body in basic HTML email structure: <!DOCTYPE html>, <html>, <head> with meta charset utf-8, <body> with the template body. Subject goes in <title> tag.
  - \`getName(): string\` — returns template name
  - \`getSubject(): string\` — returns raw subject

Export the Template class.

### personalize.ts
Smart personalization:
- \`personalize(template: string, recipient: { name: string; email: string; company?: string; role?: string }): string\` — replaces \`{{name}}\`, \`{{email}}\`, \`{{company}}\`, \`{{role}}\` with recipient data. If company is undefined, replace \`{{company}}\` with "your company". If role is undefined, replace \`{{role}}\` with "valued member". Also supports \`{{firstName}}\` — extracts first word from name.
- \`generateSubjectVariants(baseSubject: string, count: number): string[]\` — generates count variations of the subject for A/B testing. Strategies: add emoji prefix, add "Re: " prefix, make it a question, add urgency ("Don't miss:"), add personalization ("{{name}}, ..."). Return exactly count variants, cycling through strategies.
- \`segmentRecipients(recipients: Array<{ name: string; email: string; company?: string; role?: string; [key: string]: unknown }>, criteria: { field: string; value: unknown } | { field: string; condition: "exists" | "missing" }): { matched: typeof recipients; unmatched: typeof recipients }\` — splits recipients based on criteria. If value provided, match where recipient[field] === value. If condition "exists", match where field is truthy. If condition "missing", match where field is falsy.

Export all functions.

### analytics.ts
Campaign tracking and metrics:
- \`class CampaignTracker\`
  - \`constructor(campaignId: string)\`
  - \`track(event: "sent" | "opened" | "clicked" | "bounced" | "unsubscribed", recipientId: string): void\` — records event with timestamp. Multiple events per recipient allowed (e.g. opened then clicked).
  - \`getMetrics(): CampaignMetrics\` — returns:
    - \`sent: number\` — unique recipients with "sent" event
    - \`opened: number\` — unique recipients with "opened" event
    - \`clicked: number\` — unique recipients with "clicked" event
    - \`bounced: number\` — unique recipients with "bounced" event
    - \`unsubscribed: number\` — unique recipients with "unsubscribed" event
    - \`openRate: number\` — opened / sent (decimal, 0-1). 0 if no sends.
    - \`clickRate: number\` — clicked / sent (decimal, 0-1). 0 if no sends.
    - \`bounceRate: number\` — bounced / sent (decimal, 0-1). 0 if no sends.
  - \`getTopPerformers(metric: "opened" | "clicked", limit: number): string[]\` — returns recipientIds sorted by earliest event timestamp for that metric, limited to \`limit\` results.
  - \`generateReport(): CampaignReport\` — returns { campaignId, metrics, timeline, topPerformers }. Timeline: array of { date: string (YYYY-MM-DD), sent: number, opened: number, clicked: number } grouped by day.
  - \`getCampaignId(): string\`

Export the CampaignTracker class and CampaignMetrics/CampaignReport interfaces.

## Key Constraints
- Template placeholders use double curly braces: \`{{var}}\`
- Personalization must have sensible fallbacks for missing fields
- Subject variants must all be unique
- Analytics must track unique recipients per metric
- Rates must handle division by zero (return 0)
- Timeline must group events by calendar day
- Export everything`,
		keywords: [
			"Template",
			"render",
			"renderSubject",
			"validate",
			"addSection",
			"toHTML",
			"personalize",
			"generateSubjectVariants",
			"segmentRecipients",
			"CampaignTracker",
			"track",
			"getMetrics",
			"getTopPerformers",
			"generateReport",
			"template",
			"A/B test",
			"open rate",
			"click rate",
			"bounce rate",
			"unsubscribe",
			"segmentation",
			"campaign",
			"recipient",
			"HTML email",
			"export",
		],
		keywordThreshold: 13,
		testExecution: true,
		testFile: "categories/battle-test/tests/BT008-email.test.ts",
		multiFile: true,
		fixtures: [],
		timeoutMs: 30000,
	},

	// ── BT009: CI/CD Pipeline Builder ($2K value) ────────────────────
	{
		id: "BT009",
		category: "battle-test",
		title: "CI/CD Pipeline Builder — DSL, Dependency Graph, YAML Generation, Dry Run",
		difficulty: "hard",
		prompt: `Build a CI/CD pipeline definition DSL with dependency resolution and YAML output.

## Requirements

### pipeline.ts
Pipeline definition and serialization:
- \`class Pipeline\`
  - \`constructor(name: string)\`
  - \`addStage(stage: Stage): Pipeline\` — returns this for chaining. Throws if stage name already exists.
  - \`validate(): { valid: boolean; errors: string[] }\` — checks for: duplicate stage names, missing dependency references (stage depends on non-existent stage), circular dependencies (A→B→A). Returns all errors found.
  - \`toYAML(): string\` — generates GitHub Actions-style YAML. Format:
    \`\`\`yaml
    name: PipelineName
    on: [push]
    jobs:
      stage-name:
        runs-on: ubuntu-latest
        needs: [dep1, dep2]
        steps:
          - name: StepName
            run: step command
            env:
              KEY: value
    \`\`\`
    Omit \`needs\` if no dependencies. Omit \`env\` if no env vars.
  - \`toJSON(): object\` — returns plain object representation of the pipeline with name, stages array
  - \`getDependencyOrder(): string[]\` — topological sort of stage names. Stages with no deps come first. Throws if circular dependency detected.
  - \`getStages(): Stage[]\`
  - \`getName(): string\`

Export the Pipeline class.

### stage.ts
Stage definition with steps:
- \`class Stage\`
  - \`constructor(name: string, config?: { timeout?: number; condition?: string; allowFailure?: boolean })\`
  - \`dependsOn(stage: Stage | string): Stage\` — adds dependency by Stage instance or name string. Returns this for chaining.
  - \`addStep(step: { name: string; run: string; env?: Record<string, string> }): Stage\` — returns this for chaining.
  - \`addCondition(condition: string): Stage\` — sets an \`if\` condition (e.g., "github.ref == 'refs/heads/main'"). Returns this.
  - \`addArtifact(path: string): Stage\` — registers an artifact path to upload after stage. Returns this.
  - \`clone(): Stage\` — deep copy of the stage with all steps, deps, artifacts. New instance must be independent.
  - \`getName(): string\`
  - \`getDependencies(): string[]\` — returns array of dependency stage names
  - \`getSteps(): Array<{ name: string; run: string; env?: Record<string, string> }>\`
  - \`getArtifacts(): string[]\`
  - \`getCondition(): string | null\`
  - \`getConfig(): { timeout?: number; condition?: string; allowFailure?: boolean }\`

Export the Stage class.

### runner.ts
Pipeline execution simulation:
- \`class PipelineRunner\`
  - \`constructor(pipeline: Pipeline)\`
  - \`dryRun(): { valid: boolean; executionOrder: string[]; errors: string[] }\` — validates the pipeline and returns the planned execution order (topological sort). Does NOT execute any steps.
  - \`async execute(stepFn: (stageName: string, step: { name: string; run: string; env?: Record<string, string> }) => Promise<void>): Promise<ExecutionResult>\` — runs stages in dependency order. For each stage, run steps sequentially calling stepFn. If stepFn throws, mark stage as failed. Stages whose dependencies failed are skipped (marked "skipped"). Returns:
    - \`success: boolean\` — true if all stages passed
    - \`stages: Record<string, { status: "passed" | "failed" | "skipped"; duration: number; error?: string }>\`
    - \`totalDuration: number\`
  - \`getStatus(): Record<string, "pending" | "running" | "passed" | "failed" | "skipped">\`
  - \`onStageComplete(callback: (stageName: string, status: "passed" | "failed" | "skipped") => void): void\` — register callback fired after each stage completes

Export the PipelineRunner class and ExecutionResult interface.

## Key Constraints
- Topological sort must detect and throw on circular dependencies
- YAML output must be valid YAML (proper indentation, quoting)
- Clone must produce a fully independent deep copy
- Execute must respect dependency order — a stage only runs after ALL its deps pass
- Failed dependency → skip downstream stages
- Duration tracking must use real timestamps (Date.now or performance.now)
- Export everything`,
		keywords: [
			"Pipeline",
			"Stage",
			"PipelineRunner",
			"addStage",
			"addStep",
			"dependsOn",
			"validate",
			"toYAML",
			"toJSON",
			"getDependencyOrder",
			"clone",
			"dryRun",
			"execute",
			"getStatus",
			"onStageComplete",
			"topological sort",
			"YAML",
			"artifact",
			"condition",
			"parallel",
			"sequential",
			"dry run",
			"CI/CD",
			"dependency",
			"circular",
			"export",
		],
		keywordThreshold: 13,
		testExecution: true,
		testFile: "categories/battle-test/tests/BT009-cicd.test.ts",
		multiFile: true,
		fixtures: [],
		timeoutMs: 30000,
	},

	// ── BT010: Design Token System ($1.5K value) ─────────────────────
	{
		id: "BT010",
		category: "battle-test",
		title: "Design Token System — Tokens, Multi-Format Export, Color/Spacing Scales",
		difficulty: "hard",
		prompt: `Build a design token system that defines tokens and exports them to CSS, Tailwind, SCSS, and TypeScript.

## Requirements

### tokens.ts
Token definition and resolution:
- \`interface DesignToken { name: string; value: TokenValue; description?: string; type?: "color" | "spacing" | "typography" | "shadow" | "other" }\`
- \`type TokenValue = string | number | { value: string | number; [key: string]: unknown }\`
- \`interface TokenGroup { name: string; tokens: DesignToken[]; children?: TokenGroup[] }\`
- \`createToken(name: string, value: TokenValue, description?: string): DesignToken\` — factory function
- \`createGroup(name: string, tokens: DesignToken[]): TokenGroup\` — factory function
- \`resolveReference(ref: string, tokens: Map<string, DesignToken>): TokenValue\` — handles references like \`{color.primary}\`. The ref string is in format "{group.name}". Look up the dot-path key in the Map. If not found, return the ref string unchanged. If the resolved value is itself a reference, resolve recursively (max depth 10 to prevent infinite loops).
- \`flattenTokens(group: TokenGroup): Map<string, DesignToken>\` — recursively flattens a TokenGroup into a flat Map where keys are dot-notation paths. E.g., group "color" with token "primary" → key "color.primary". Child groups nest: "color.brand.primary".

Export all interfaces, types, and functions.

### transformer.ts
Multi-format token export:
- \`toCSSVariables(tokens: Map<string, DesignToken>): string\` — outputs CSS custom properties. Format:
  \`\`\`css
  :root {
    --color-primary: #3b82f6;
    --spacing-sm: 8px;
  }
  \`\`\`
  Convert dot-notation to kebab-case (color.primary → color-primary). Numeric values get "px" suffix if type is "spacing", "rem" if type is "typography". Wrap in :root { }.

- \`toTailwindConfig(tokens: Map<string, DesignToken>): object\` — outputs a Tailwind CSS theme extend-compatible object. Group by token type: colors go under "colors", spacing under "spacing", typography under "fontSize", shadows under "boxShadow". Use the last segment of the name as key. E.g., color.primary → { colors: { primary: "#3b82f6" } }.

- \`toSCSSVariables(tokens: Map<string, DesignToken>): string\` — outputs SCSS variables. Format: \`$color-primary: #3b82f6;\` per line. Same kebab-case conversion.

- \`toJSON(tokens: Map<string, DesignToken>): string\` — outputs formatted JSON. Keys are dot-notation paths, values are token values. Pretty-printed with 2-space indent.

- \`toTypeScript(tokens: Map<string, DesignToken>): string\` — generates a TypeScript file with a typed const. Format:
  \`\`\`typescript
  export const tokens = {
    color: {
      primary: "#3b82f6",
    },
    spacing: {
      sm: 8,
    },
  } as const;
  \`\`\`
  Reconstruct nested object from dot-notation paths.

Export all functions.

### generator.ts
Scale generation utilities:
- \`generateColorScale(baseHex: string, steps: number): Record<string, string>\` — generates lighter and darker variants of a hex color using HSL manipulation. Takes a hex color like "#3b82f6". Parse to HSL. Generate \`steps\` shades from light (high L) to dark (low L), evenly distributed. Keys are numeric: { "50": "#eff6ff", "100": ..., "900": "#1e3a5f" } for steps=10. Use standard 50,100,200,...,900 scale keys if steps <= 10.
- \`generateSpacingScale(base: number, ratio: number, steps: number): Record<string, number>\` — generates spacing values. Start from base, multiply by ratio for each step. Keys: "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl" (use first \`steps\` keys). E.g., base=4, ratio=2, steps=5 → { xs: 4, sm: 8, md: 16, lg: 32, xl: 64 }.
- \`generateTypographyScale(base: number, ratio: number): Record<string, number>\` — generates font sizes using a type scale. Keys: "xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl". "base" = base value. Each step up multiplies by ratio, each step down divides. Round to 2 decimal places.
- \`generateShadowScale(steps: number): Record<string, string>\` — generates CSS box-shadow values from subtle to dramatic. Step 1: "0 1px 2px rgba(0,0,0,0.05)". Increase offset-y, blur, spread, and opacity linearly. Keys: "sm", "md", "lg", "xl", "2xl" (first \`steps\` keys).

Export all functions.

## Key Constraints
- Reference resolution must handle circular references (max depth 10)
- CSS variable names must be valid (kebab-case, no dots)
- Tailwind config must be a valid theme extend object
- Color scale must produce valid hex colors
- Spacing scale must be mathematically consistent (each step = previous * ratio)
- Typography scale must center on "base" key
- All generators must return the exact number of steps requested
- Export everything`,
		keywords: [
			"DesignToken",
			"TokenGroup",
			"TokenValue",
			"createToken",
			"createGroup",
			"resolveReference",
			"flattenTokens",
			"toCSSVariables",
			"toTailwindConfig",
			"toSCSSVariables",
			"toJSON",
			"toTypeScript",
			"generateColorScale",
			"generateSpacingScale",
			"generateTypographyScale",
			"generateShadowScale",
			"design token",
			"CSS variable",
			"Tailwind",
			"SCSS",
			"color scale",
			"spacing",
			"typography",
			"shadow",
			"HSL",
			"reference",
			"flatten",
			"export",
		],
		keywordThreshold: 14,
		testExecution: true,
		testFile: "categories/battle-test/tests/BT010-design-tokens.test.ts",
		multiFile: true,
		fixtures: [],
		timeoutMs: 30000,
	},
];
