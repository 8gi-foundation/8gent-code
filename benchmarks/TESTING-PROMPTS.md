# 8gent Battle Test Prompts — Manual Testing

Copy-paste these prompts into 8gent (or any LLM) to test. Each prompt asks for multi-file TypeScript output.

---

## BT001: SaaS Auth System (Score: 94)

Build a complete authentication system for a SaaS product.

### Requirements

Implement these files:

#### auth.ts
Core authentication module:
- `hashPassword(password: string): Promise<string>` — bcrypt-style hashing (use crypto.subtle or built-in)
- `verifyPassword(password: string, hash: string): Promise<boolean>`
- `generateToken(payload: { userId: string; role: Role; email: string }, secret: string, expiresIn?: number): string` — JWT-like token (base64 encoded JSON with signature)
- `verifyToken(token: string, secret: string): TokenPayload | null` — returns null if expired or invalid
- `generateRefreshToken(): string` — random 64-char hex string
- `generateResetCode(): string` — 6-digit numeric code

Token format: `base64(header).base64(payload).hmacSignature`
Payload must include `exp` (expiry timestamp), `iat` (issued at), `userId`, `role`, `email`.

#### rbac.ts
Role-based access control:
- Roles: `admin`, `editor`, `viewer`, `billing`
- Type: `type Role = "admin" | "editor" | "viewer" | "billing"`
- `type Permission = "read" | "write" | "delete" | "manage_users" | "manage_billing" | "view_analytics"`
- `hasPermission(role: Role, permission: Permission): boolean`
- `canAccessResource(role: Role, resource: string, action: "read" | "write" | "delete"): boolean`
- Admin has all permissions
- Editor: read, write, view_analytics
- Viewer: read only
- Billing: read, manage_billing, view_analytics

#### rate-limiter.ts
Token bucket rate limiter:
- `class RateLimiter` with constructor `(maxRequests: number, windowMs: number)`
- `check(key: string): { allowed: boolean; remaining: number; resetAt: number }`
- `reset(key: string): void`
- Tracks per-key (e.g. per IP or per user)
- Window-based: resets after windowMs
- Must handle concurrent calls correctly

#### user-store.ts
In-memory user store:
- `class UserStore`
- `async createUser(email: string, password: string, role?: Role): Promise<User>` — hashes password, generates ID
- `async findByEmail(email: string): Promise<User | null>`
- `async findById(id: string): Promise<User | null>`
- `async updatePassword(userId: string, newPassword: string): Promise<void>`
- `async setResetCode(userId: string): Promise<string>` — generates and stores reset code
- `async verifyResetCode(userId: string, code: string): Promise<boolean>`
- Duplicate email → throw Error("Email already exists")

Interface User: { id: string; email: string; passwordHash: string; role: Role; createdAt: number; resetCode?: string; resetCodeExpiry?: number }

### Key Constraints
- No external dependencies — use built-in crypto only
- Token expiry must work (default 1 hour = 3600000ms)
- Rate limiter must be time-based, not counter-based
- Password hashing must be async (use PBKDF2 or similar)
- All functions must be properly exported

---

## BT003: Data Pipeline (Score: 100)

Build a typed data pipeline system for ETL-style processing.

### Requirements

#### pipeline.ts
Composable pipeline builder:
- `class Pipeline<TIn, TOut>`
- `static from<T>(source: Iterable<T> | AsyncIterable<T> | T[]): Pipeline<T, T>`
- `.map<U>(fn: (item: TOut) => U | Promise<U>): Pipeline<TIn, U>`
- `.filter(fn: (item: TOut) => boolean): Pipeline<TIn, TOut>`
- `.flatMap<U>(fn: (item: TOut) => U[] | Promise<U[]>): Pipeline<TIn, U>`
- `.batch(size: number): Pipeline<TIn, TOut[]>` — group into batches of N
- `.tap(fn: (item: TOut) => void): Pipeline<TIn, TOut>` — side effect, passes through
- `.take(n: number): Pipeline<TIn, TOut>` — only first N items
- `.skip(n: number): Pipeline<TIn, TOut>` — skip first N items
- `.collect(): Promise<TOut[]>` — execute pipeline, return results
- `.reduce<U>(fn: (acc: U, item: TOut) => U, initial: U): Promise<U>`
- `.count(): Promise<number>`

#### schema.ts
Runtime type validation:
- `const S = { string: () => StringSchema, number: () => NumberSchema, boolean: () => BooleanSchema, object: <T>(shape: T) => ObjectSchema<T>, array: <T>(item: T) => ArraySchema<T>, optional: <T>(schema: T) => OptionalSchema<T> }`
- Each schema has `.validate(value: unknown): { valid: boolean; errors: string[] }`
- `StringSchema` has `.min(n)`, `.max(n)`, `.pattern(regex)`, `.email()`
- `NumberSchema` has `.min(n)`, `.max(n)`, `.integer()`, `.positive()`
- `ObjectSchema` validates shape recursively
- `ArraySchema` validates each element
- Return detailed error paths: "field.nested.0.name: must be a string"

#### transforms.ts
Common data transformations:
- `function deduplicate<T>(items: T[], key?: (item: T) => unknown): T[]`
- `function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]>`
- `function sortBy<T>(items: T[], key: (item: T) => number | string, order?: "asc" | "desc"): T[]`
- `function pivot<T>(items: T[], rowKey: string, colKey: string, valueKey: string): Record<string, Record<string, unknown>>`
- `function flatten<T>(nested: (T | T[])[]): T[]`
- `function chunk<T>(items: T[], size: number): T[][]`
- `function zip<A, B>(a: A[], b: B[]): [A, B][]`

### Key Constraints
- Pipeline must be lazy (operations only run on collect/reduce/count)
- Pipeline must handle async map/flatMap
- Schema validation must return ALL errors, not just the first
- Error paths must use dot notation for nested objects
- Transforms must not mutate input arrays
- Export all classes, functions, and the S schema builder

---

## BT007: SEO Audit Engine (Score: 96)

Build an SEO audit engine that analyzes web pages and generates actionable reports.

### Requirements

#### analyzer.ts
HTML and content analysis functions:
- `analyzeMeta(html: string): MetaAnalysis` — parse an HTML string and extract: title, description, h1s, h2s, imagesWithoutAlt count, canonical URL, robots meta
- `analyzeContent(text: string): ContentAnalysis` — wordCount, readingLevel (Flesch-Kincaid grade), keywordDensity function
- `analyzeLinks(links: { url: string; text: string; rel?: string }[]): LinkAnalysis` — internal/external/nofollow/emptyText counts

#### scorer.ts
Each returns `{ score: number; issues: string[]; recommendations: string[] }` where score is 0-100:
- `scoreMeta(meta: MetaAnalysis)` — Deduct: no title (-30), title >60 chars (-10), no description (-20), desc >160 chars (-10), no h1 (-15), multiple h1s (-10), images without alt (-5 each, max -20), no canonical (-5)
- `scoreContent(content: ContentAnalysis)` — word count <300 (-30), <600 (-15). Reading level >12 (-20), >16 (-10)
- `scoreLinks(links: LinkAnalysis)` — no internal links (-20), >50% nofollow (-15), empty link text (-10 each, max -30)
- `scorePerformance(metrics: { lcp: number; fid: number; cls: number })` — Core Web Vitals: LCP <2.5s good, 2.5-4s (-20), >4s (-40). FID <100ms good, 100-300ms (-20), >300ms (-40). CLS <0.1 good, 0.1-0.25 (-15), >0.25 (-30)
- `overallScore(scores: ScoreResult[])` — weighted: meta 30%, content 25%, links 20%, performance 25%

#### reporter.ts
- `generateAuditReport(url, scores)` — Grade: 90-100=A, 80-89=B, 70-79=C, 60-69=D, <60=F. Summary with grade and top issues.

### Key Constraints
- Regex-based HTML parsing (no external DOM libraries)
- Flesch-Kincaid standard formula
- All scores clamped 0-100
- Export everything

---

## BT011: Video Production Planner (Score: 100)

Build a video production planning system with timeline management and export tools.

### Requirements

#### scene.ts
- `class Scene` — constructor(id, duration, type: "intro"|"main"|"transition"|"outro"|"b-roll")
- `.addAsset(asset: Asset)`, `.removeAsset(src)`, `.addEffect(effect: Effect)`, `.getAssets()`, `.getEffects()`

#### timeline.ts
- `class Timeline`
- `.addScene(scene)`, `.removeScene(id)`, `.reorderScenes(ids: string[])`
- `.getTotalDuration()`, `.getSceneAt(timeMs)`, `.splitScene(id, atMs)` → [Scene, Scene]
- `.validate()` — check for gaps/overlaps
- `.toEDL()` — Edit Decision List format

#### exporter.ts
- `generateFFmpegCommand(timeline, config: { format, resolution, fps, codec? })` — valid ffmpeg CLI string
- `estimateFileSize(timeline, config)` — bitrate = w * h * fps * 0.07 * duration
- `generateShotList(timeline)` — markdown table

### Key Constraints
- Assets: startTime < endTime
- EDL format: "index reel type HH:MM:SS:FF" per line
- FFmpeg must include -i, -s WxH, -r fps
- Export all classes, interfaces, functions

---

## BT014: AI Consultancy Reports (Score: 95)

Build an AI consultancy report system — assessment, recommendations, roadmap.

### Requirements

#### assessment.ts
- `assessAIReadiness(company: CompanyProfile): ReadinessReport`
- Score: dataMaturity*15 + (tools.length*5, max 20) + budget tier + size bonus + painPoints bonus
- Tier: 0-40 beginner, 41-70 intermediate, 71-100 advanced
- `benchmarkAgainstIndustry(profile, industryData[])` — percentile ranking

#### recommendation.ts
- `generateRecommendations(report, budget)` — tier-appropriate suggestions filtered by budget
- `prioritize(recs, criteria: "roi"|"speed"|"impact")` — sorted recommendations
- `estimateTotalCost(recs)` — cost = sum(weeks*2500), timeline = max weeks + buffer

#### roadmap.ts
- `generateRoadmap(recs, startDate)` — phases: Foundation, Implementation, Optimization
- `toGanttData(phases)` — flat task list with dates
- `toMarkdown(phases)` — formatted with ## headers, bullets, dates

### Key Constraints
- Deterministic scoring (same input = same output)
- Valid ISO dates, sequential
- Export all interfaces and functions

---

## BT002: Event-Driven Architecture (Score: 92)

Build a production-grade event system for microservice communication.

### Requirements

#### event-bus.ts
- `class EventBus` with on/emit/once/off, priority ordering, filter option
- `emit` returns { delivered, failed, errors }

#### retry-handler.ts
- `class RetryHandler` with exponential backoff + jitter
- Delay: min(baseDelay * multiplier^attempt, maxDelay) + random jitter (+-10%)

#### dead-letter-queue.ts
- `class DeadLetterQueue` — enqueue/dequeue/peek/retry/retryAll/size/list/purge
- FIFO, tracks attempt count

#### backpressure.ts
- `class BackpressureController` — acquire/release/run with maxConcurrent and maxQueueSize
- Queue overflow → throw BackpressureError

### Key Constraints
- Priority ordering stable (same priority = insertion order)
- DLQ entries track attempt count across retries
- Backpressure uses promises (not polling)
- Export everything

---

## BT005: State Machine Engine (Score: 92)

Build a state machine engine inspired by XState — from scratch.

### Requirements

#### machine.ts
- `createMachine<TContext>(config)` — MachineConfig with states, transitions, guards, actions
- `.transition(state, event, context)` → TransitionResult

#### interpreter.ts
- `class Interpreter` — start/send/getState/getContext/subscribe/stop
- Entry/exit actions fire in correct order

#### guards.ts
- `and`, `or`, `not`, `equals`, `greaterThan` — composable guard functions

#### actions.ts
- `assign` (immutable update), `log`, `raise` (internal event), `choose` (conditional)

### Key Constraints
- Guards evaluated BEFORE transition
- Action order: exit old → transition actions → entry new
- Nested states with dot notation
- Export everything

---

## BT012: Music Theory Engine (Score: 81)

Build a music theory engine with note manipulation, chord construction, progression analysis.

### Requirements

#### theory.ts
- 12 chromatic notes, MIDI conversion (C4=60), transpose, getInterval
- Scale patterns: major, minor, dorian, mixolydian, pentatonic, blues

#### chord.ts
- `class Chord` — root + quality (major/minor/dim/aug/dom7/maj7/min7)
- getNotes, invert, toSymbol, fromSymbol (parse "Am7", "G", "Bdim", etc.)

#### progression.ts
- `class ChordProgression` — key + mode, analyze (roman numerals + tensions), transpose, suggest, toNashvilleNumbers

### Key Constraints
- MIDI: C4 = 60
- Transpose wraps: B+1=C, C-1=B
- fromSymbol handles all quality suffixes
- Export everything
