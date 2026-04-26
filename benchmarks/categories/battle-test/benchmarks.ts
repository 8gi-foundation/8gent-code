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
- \`.command(name: string, description: string): Command\` — registers a command and returns a Command builder.
- \`.parse(argv: string[]): ParseResult\` — parse argv and route to command
- \`.help(): string\` — generate help text. **Must include the names of all registered commands** (tests assert \`helpText.includes("init")\` and \`helpText.includes("build")\`).
- \`.version(): string\` — returns the version string passed to the constructor (e.g., "1.0.0").

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
- \`interface FinancialStatement { revenue: number; cogs: number; netIncome: number; totalDebt: number; equity: number; currentAssets: number; currentLiabilities: number }\`
- \`interface BalanceSheet { totalAssets: number; currentAssets: number; totalLiabilities: number; currentLiabilities: number; shareholdersEquity: number }\`
- \`interface IncomeStatement { revenue: number; costOfGoodsSold: number; grossProfit: number; operatingIncome: number; netIncome: number }\`
- \`interface CashFlow { operatingCashFlow: number; investingCashFlow: number; financingCashFlow: number; freeCashFlow: number }\`
- \`interface Ratio { name: string; value: number; benchmark?: number; status: "good" | "warning" | "critical" }\`
- \`interface FinancialAnalysis { grossMargin: number; netMargin: number; debtToEquity: number; currentRatio: number; roi?: number; ebitda?: number }\`

Export all interfaces.

### calculator.ts
Financial calculation functions. **CRITICAL: All margin/ROI functions return PERCENTAGE values (50, not 0.5).**
- \`calculateROI(gain: number, cost: number): number\` — returns PERCENTAGE. Formula: \`((gain - cost) / cost) * 100\`. So calculateROI(1500, 1000) returns 50, calculateROI(800, 1000) returns -20.
- \`calculateNPV(discountRate: number, cashFlows: number[]): number\` — **rate is FIRST arg, cashFlows is SECOND**. Net Present Value. cashFlows[0] is initial investment (typically negative). Formula: sum of cashFlows[t] / (1 + rate)^t for t=0..n
- \`calculateIRR(cashFlows: number[], tolerance?: number, maxIterations?: number): number\` — Internal Rate of Return using bisection method. Find rate where NPV = 0. Search range -0.5 to 10.0. Default tolerance 0.0001, maxIterations 1000. Returns decimal rate.
- \`calculateDebtToEquity(totalDebt: number, equity: number): number\` — returns ratio (e.g., 0.5)
- \`calculateCurrentRatio(currentAssets: number, currentLiabilities: number): number\` — returns ratio (e.g., 1.5)
- \`calculateGrossMargin(revenue: number, cogs: number): number\` — returns PERCENTAGE. Formula: \`((revenue - cogs) / revenue) * 100\`. So calculateGrossMargin(100000, 60000) returns 40.
- \`calculateNetMargin(netIncome: number, revenue: number): number\` — returns PERCENTAGE. Formula: \`(netIncome / revenue) * 100\`. So calculateNetMargin(20000, 100000) returns 20.
- \`calculateEBITDA(operatingIncome: number, depreciation: number, amortization: number, interest: number, taxes: number): number\` — **5 args**. Returns sum of all five (NI + I + T + D + A reconstruction). So calculateEBITDA(50000, 10000, 15000, 5000, 3000) returns 83000.
- \`analyzeFinancials(data: FinancialStatement): FinancialAnalysis\` — returns an OBJECT (not array) with keys: \`grossMargin\`, \`netMargin\`, \`debtToEquity\`, \`currentRatio\` (and optionally \`roi\`, \`ebitda\`). Each value is the result of calling the corresponding calculator function.

Export all functions.

### formatter.ts
Display formatting:
- \`formatCurrency(value: number, currency?: string): string\` — default USD. Returns "$1,234,567.89" format with comma thousands separators and 2 decimal places. Handles zero: returns "$0.00". Handles negatives: "-$1,234.56" or "($1,234.56)".
- \`formatPercentage(value: number, decimals?: number): string\` — input is DECIMAL (0.4567 → "45.67%"). Multiplies by 100. Default 2 decimal places.
- \`formatFinancialReport(analysis: FinancialAnalysis | Record<string, number>): string\` — returns a non-empty markdown string summarizing the analysis ratios. Must include the ratio names and values.

Export all functions.

## Key Constraints
- ROI and Margin functions return percentages (50 means 50%, not 0.5)
- NPV signature: \`calculateNPV(rate, cashFlows)\` — rate first
- EBITDA takes 5 args and returns their sum
- analyzeFinancials returns OBJECT with property access (not array iteration)
- formatPercentage takes decimal input but outputs percentage display
- All ratio calculations must handle division by zero gracefully (return 0)
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
  - \`constructor(body: string, subject: string)\` — **body is FIRST arg, subject is SECOND**. Example: \`new Template("Hello {{name}}!", "Greeting")\`.
  - \`subject\` — public property, accessible as \`t.subject\` (no getter method needed).
  - \`render(vars: Record<string, string>): string\` — replaces all \`{{varName}}\` placeholders in body with values from vars. Unknown placeholders remain as-is.
  - \`validate(vars: Record<string, string>): string[]\` — returns ARRAY of error strings for variables in the template that are NOT supplied in \`vars\`. Empty array means valid.
  - \`addSection(name: string, content: string): void\` — appends content to body so it appears in render output. The content must be returned by subsequent render() calls.
  - \`toHTML(vars: Record<string, string>): string\` — **takes vars argument**. Returns HTML email document containing \`<html\` tag and the rendered body with vars substituted.

Export the Template class.

### personalize.ts
Smart personalization:
- \`personalize(template: string, primaryVars: Record<string, string>, fallbackVars?: Record<string, string>): string\` — **3 args**. Replaces \`{{var}}\` placeholders in template using primaryVars first, then fallbackVars for any missing keys. Unknown placeholders remain as-is.
- \`generateSubjectVariants(baseSubject: string, count: number): string[]\` — generates exactly \`count\` distinct variations of the subject for A/B testing. Strategies: add prefix, make it a question, add urgency, add emoji, etc.
- \`segmentRecipients(recipients: Array<Record<string, unknown>>, fieldName: string): Record<string, Array<Record<string, unknown>>>\` — **2 args** (recipients array, field name string). Returns object keyed by the unique values of \`fieldName\`, with each key mapping to the array of recipients having that value. Example: \`segment([{tier:"premium"}, {tier:"free"}], "tier")\` returns \`{ premium: [...], free: [...] }\`.

Export all functions.

### analytics.ts
Campaign tracking and metrics:
- \`class CampaignTracker\`
  - \`constructor(campaignId: string)\`
  - \`track(event: "sent" | "opened" | "clicked" | "bounced" | "unsubscribed", recipientId: string): void\` — records event with timestamp.
  - \`getEvents(): Array<{ event: string; recipientId: string; timestamp: number }>\` — returns ALL recorded events in order tracked.
  - \`getMetrics(): { sent: number; opened: number; clicked: number; openRate: number; clickRate: number; bounceRate: number }\` — counts unique recipients per event type. **openRate = opened / sent**. **clickRate = clicked / opened** (NOT clicked/sent — clicks are conditional on opens). bounceRate = bounced / sent. All rates return 0 when denominator is 0.
  - \`getTopPerformers(): string[]\` — **no arguments**. Returns recipientIds sorted by total engagement (most engaged first). A recipient with both "opened" and "clicked" events ranks higher than one with only "opened".
  - \`generateReport(): { campaignId: string; metrics: object }\` — returns object with at least \`campaignId\` and \`metrics\` properties.

Export the CampaignTracker class.

## Key Constraints
- Template constructor signature is \`(body, subject)\` — body first
- Template's \`subject\` is a public property, not a getter
- toHTML takes vars and renders them inline
- personalize takes 3 args: template, primary vars, fallback vars
- segmentRecipients groups by field VALUE, returns object keyed by those values
- clickRate uses opened (not sent) as denominator
- getTopPerformers takes no arguments
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
  - \`addStage(name: string, dependencies: string[]): Pipeline\` — **2 simple args** (stage name string, deps array). Returns this for chaining. Internally creates a Stage record with the given name and deps.
  - \`stages\` — public array property exposing the registered stages. Tests check \`p.stages.length\`.
  - \`getStages(): Array<{ name: string; dependencies: string[] }>\` — also provided for callers preferring a method.
  - \`validate(): { valid: boolean; errors: string[] }\` — checks for: duplicate stage names, dependency references to non-existent stages, circular dependencies. Returns all errors found.
  - \`toYAML(): string\` — generates a YAML-like string containing each stage name. Tests just check it contains the stage names and is a string.
  - \`toJSON(): string\` — **returns a STRING** (\`JSON.stringify(...)\`). The parsed JSON must have a \`name\` property.
  - \`getDependencyOrder(): string[]\` — topological sort of stage names. Stages with no deps first.
  - \`getName(): string\`

Export the Pipeline class.

### stage.ts
Stage definition with steps:
- \`class Stage\`
  - \`constructor(name: string)\`
  - \`name\` — public property, accessed as \`s.name\` (no getter required).
  - \`dependsOn(stageName: string): Stage\` — accepts a string (or Stage). Returns this. Recorded in \`dependencies\` array.
  - \`dependencies\` — public array property of dep names, OR provide \`getDependencies(): string[]\`.
  - \`addStep(name: string, fn: () => void | Promise<void>): Stage\` — **2 args**: step name string, step function. Returns this. Recorded in \`steps\` array.
  - \`steps\` — public array property OR provide \`getSteps(): Array<{ name: string; fn: Function }>\`.
  - \`addCondition(key: string, value: string): Stage\` — **2 args** (key/value pair). Recorded in \`conditions\` (object or array). Tests check that getConditions() returns something with at least one entry.
  - \`getConditions(): Record<string, string> | Array<{ key: string; value: string }>\` — returns the recorded conditions. Length or key count must be > 0 after addCondition is called.
  - \`clone(): Stage\` — deep copy. The new Stage has the same name and a fresh independent steps/deps array.

Export the Stage class.

### runner.ts
Pipeline execution simulation:
- \`class Runner\` — **class name is \`Runner\` (NOT PipelineRunner)**.
  - \`constructor(pipeline: Pipeline)\`
  - \`dryRun(): string[]\` — **returns a non-empty ARRAY** of stage names in the planned execution order. Does NOT execute any steps.
  - \`async execute(options?: { onStep?: (stageName: string, stepName?: string) => void | Promise<void> }): Promise<void>\` — accepts optional options object with \`onStep\` callback. Must work with no args too: \`r.execute()\`. Calls \`onStep\` (if provided) for each step in each stage in dependency order. Updates internal status as it runs.
  - \`getStatus(): Record<string, "pending" | "passed" | "failed">\` — returns object keyed by stage name. After execute(), every stage has a recorded status.
  - \`onStageComplete(callback: (stageName: string) => void): void\` — registers a callback fired when each stage completes. **Callback receives only the stage name** (not status).

Export the Runner class.

## Key Constraints
- \`addStage(name, deps)\` takes 2 plain args — not a Stage object
- \`Stage.addStep(name, fn)\` takes 2 args — name string and function
- \`Stage.addCondition(key, value)\` takes 2 args — key and value
- Class is \`Runner\` not \`PipelineRunner\`
- \`dryRun()\` returns a string array
- \`execute()\` accepts options object with \`onStep\`
- \`onStageComplete\` callback receives only the stage name
- \`toJSON\` returns a JSON string, not a plain object
- Topological sort must detect circular dependencies
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
- \`interface DesignToken { name: string; value: string | number; type?: "color" | "spacing" | "typography" | "shadow" | "other" }\`
- \`interface TokenGroup { name: string; tokens: DesignToken[]; children?: TokenGroup[] }\`
- \`createToken(name: string, value: string | number, options?: { type?: string; description?: string }): DesignToken\` — **3rd arg is OPTIONS OBJECT** (not a description string). Returns \`{ name, value, type? }\`.
- \`createGroup(name: string, tokens: DesignToken[], children?: TokenGroup[]): TokenGroup\` — **3 positional args**: name, tokens array, optional children array. Used as \`createGroup("color", [], [innerGroup])\`.
- \`resolveReference(ref: string, tokenMap: Record<string, DesignToken>): string | number\` — **tokenMap is a plain OBJECT** (not Map). Ref format: \`"{color.primary}"\`. Look up by dot-path. If found, return the token's \`value\`. If not found, return the ref unchanged. Resolve recursively up to depth 10.
- \`flattenTokens(group: TokenGroup): Record<string, string | number>\` — **returns a plain OBJECT** (not Map) keyed by dot-notation paths whose values are the token VALUES (not the token objects). For nested children, paths chain: \`"color.brand.primary"\`. So \`flat["color.primary"]\` returns "#3b82f6".

Export all interfaces and functions.

### transformer.ts
Multi-format token export. **All transformer functions accept a plain Record<string, string | number> mapping dot-paths to values** (the output of flattenTokens).
- \`toCSSVariables(tokens: Record<string, string | number>): string\` — outputs CSS custom properties wrapped in \`:root { ... }\`. Each key becomes \`--<kebab-case-key>: <value>;\`. So \`{ "color.primary": "#3b82f6", "spacing.sm": "8px" }\` produces lines containing \`--color-primary: #3b82f6\` and \`--spacing-sm: 8px\`.
- \`toTailwindConfig(tokens: Record<string, string | number>): object\` — returns a plain object. Group by the FIRST segment of the dot-path: \`{ "color.primary": "..." }\` becomes \`{ color: { primary: "..." } }\`. Tests check that \`result.color\` (or \`result.colors\`) is truthy.
- \`toSCSSVariables(tokens: Record<string, string | number>): string\` — outputs lines like \`$color-primary: #3b82f6;\` (kebab-case + \`$\` prefix).
- \`toJSON(tokens: Record<string, string | number>): string\` — returns \`JSON.stringify(tokens, null, 2)\`. Keys remain dot-notation. Tests do \`JSON.parse(result)\` and check \`parsed["color.primary"]\` exists.
- \`toTypeScript(tokens: Record<string, string | number>): string\` — generates a TypeScript file containing the keyword \`const\` and the values themselves. Tests just check \`result.includes("const")\` and includes the token value.

Export all functions.

### generator.ts
Scale generation utilities. **ALL generators return ARRAYS, not objects.**
- \`generateColorScale(baseHex: string, steps: number): string[]\` — returns an ARRAY of \`steps\` hex color strings, going from lighter to darker (or vice versa). The first and last entries must differ. Use HSL manipulation.
- \`generateSpacingScale(base: number, steps: number): number[]\` — **2 args** (no ratio). Returns an ARRAY of \`steps\` numbers. Use a sensible scale (e.g., \`base * 2^i\` or \`base * (i+1)\`). All entries must be numbers.
- \`generateTypographyScale(base: number, steps: number): number[]\` — **2 args**. Returns an ARRAY of \`steps\` numbers in STRICTLY INCREASING order. So \`scale[i+1] > scale[i]\` for all i.
- \`generateShadowScale(steps: number): string[]\` — returns an ARRAY of \`steps\` CSS box-shadow strings (e.g., "0 1px 2px rgba(0,0,0,0.05)").

Export all functions.

## Key Constraints
- \`createToken(name, value, { type })\` — 3rd arg is options object
- \`createGroup(name, tokens, children?)\` — children as 3rd POSITIONAL arg
- All transformer functions accept plain object \`Record<string, string|number>\`, not Map
- \`flattenTokens\` returns a plain object whose values are the token values
- \`generateColorScale\`, \`generateSpacingScale\`, \`generateTypographyScale\`, \`generateShadowScale\` ALL return ARRAYS of length \`steps\`
- \`generateSpacingScale\` and \`generateTypographyScale\` take **2 args** (base, steps) — no ratio parameter
- Typography scale must be strictly increasing
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
