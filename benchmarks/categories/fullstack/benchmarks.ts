import type { BenchmarkDefinition } from "../../types";
import { motherloadBenchmark } from "./motherload";

export const fullstackBenchmarks: BenchmarkDefinition[] = [
  ...motherloadBenchmark,
  {
    id: "FS001",
    category: "fullstack",
    title: "REST API with Auth — Register, Login, Protected Routes",
    difficulty: "hard",
    prompt: `You are given an existing Database class and an HTTP Router. Build a complete REST API with authentication.

## Existing System (provided — DO NOT reimplement these)

### database.ts (already exists in your working directory)
\`\`\`typescript
// In-memory database with these methods:
// db.createUser(user: User): User              — throws if email exists
// db.getUserById(id: string): User | null
// db.getUserByEmail(email: string): User | null
// db.createSession(session: Session): Session
// db.getSession(token: string): Session | null  — returns null if expired
// db.deleteSession(token: string): boolean
// hashPassword(password: string): string
// generateId(): string
// generateToken(): string
//
// Types: User { id, email, name, passwordHash, createdAt }
//        Session { token, userId, expiresAt }
\`\`\`

### http.ts (already exists in your working directory)
\`\`\`typescript
// Router with middleware support:
// router.use(middleware: Middleware)
// router.get/post/put/delete(path, handler)
// router.handle(req: HttpRequest): Promise<HttpResponse>
// makeRequest(method, path, body?, headers?): HttpRequest
//
// Types:
//   HttpRequest { method, path, headers, body, user?, ctx }
//   HttpResponse { status, headers, body }
//   Middleware = (req, next) => HttpResponse | Promise<HttpResponse>
\`\`\`

## Your Task

Create **three files** that build a full REST API. Use the file marker format shown below.

### 1. auth.ts — Authentication helpers
- \`createAuthMiddleware(db)\` — Middleware that:
  - Reads \`Authorization: Bearer <token>\` header
  - Looks up session in db, attaches \`req.user\` if valid
  - Calls \`next()\` regardless (some routes don't need auth)
- \`requireAuth\` — Middleware that returns 401 if \`req.user\` is null after auth middleware ran

### 2. routes.ts — API route handlers
- \`POST /register\` — body: { email, name, password }. Validates all fields, hashes password, creates user, returns user (without passwordHash). 400 on missing fields, 409 on duplicate email.
- \`POST /login\` — body: { email, password }. Verifies credentials, creates session (1hr expiry), returns { token, user }. 401 on bad credentials.
- \`GET /profile\` — Protected. Returns the authenticated user's profile. 401 if not authenticated.
- \`POST /logout\` — Protected. Deletes the session. Returns { success: true }.

### 3. app.ts — Wire everything together
- Export a \`createApp()\` function that:
  - Creates a Database instance and a Router
  - Applies auth middleware globally
  - Registers all routes
  - Returns \`{ router, db }\` so tests can access both

## Output Format

Use these exact file markers:

\`\`\`typescript // auth.ts
// your auth code here
\`\`\`

\`\`\`typescript // routes.ts
// your routes code here
\`\`\`

\`\`\`typescript // app.ts
// your app wiring code here
\`\`\``,
    keywords: [
      "createAuthMiddleware", "requireAuth", "Authorization", "Bearer",
      "register", "login", "profile", "logout",
      "hashPassword", "generateToken", "createSession", "getSession",
      "401", "409", "400",
      "createApp", "router", "middleware",
    ],
    keywordThreshold: 10,
    testExecution: true,
    testFile: "autoresearch/tests/FS001-auth-api.test.ts",
    timeoutMs: 30000,
    multiFile: true,
    fixtures: ["fixtures/database.ts", "fixtures/http.ts"],
  },

  {
    id: "FS002",
    category: "fullstack",
    title: "Task Queue with Workers, Retry, and Dead Letter Queue",
    difficulty: "hard",
    prompt: `Build a complete task queue system with worker processing, automatic retries, and a dead letter queue.

## Your Task

Create **four files** that implement a production-grade task queue.

### 1. types.ts — Shared types
\`\`\`typescript
interface Task {
  id: string;
  type: string;
  payload: any;
  priority: number;        // higher = more important
  status: "pending" | "processing" | "completed" | "failed" | "dead";
  attempts: number;
  maxRetries: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
  result?: any;
}

interface QueueStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  dead: number;
}
\`\`\`

### 2. queue.ts — Priority queue implementation
- \`enqueue(task)\` — Adds task with status "pending", sorted by priority
- \`dequeue()\` — Returns highest-priority pending task, marks "processing"
- \`complete(taskId, result)\` — Marks task "completed" with result
- \`fail(taskId, error)\` — If attempts < maxRetries, re-enqueue as "pending" with incremented attempts. Otherwise mark "dead" and move to DLQ.
- \`stats()\` — Returns QueueStats
- \`getDeadLetterQueue()\` — Returns all dead tasks

### 3. worker.ts — Task processor
- \`Worker\` class with \`constructor(queue, handlers)\`
  - \`handlers\` is a \`Record<string, (payload) => Promise<any>>\` mapping task types to processors
- \`start()\` — Begins polling the queue (poll interval: 50ms for testing)
- \`stop()\` — Stops polling
- \`processOne()\` — Dequeues and processes a single task. On handler error, calls \`queue.fail()\`
- Must handle: missing handler for task type (fail with "no handler" error)

### 4. scheduler.ts — Task creation helpers
- \`createTask(type, payload, options?)\` — Creates a Task object with defaults (priority: 0, maxRetries: 3)
- \`createBatch(tasks[])\` — Enqueues multiple tasks, returns their IDs
- \`schedule(queue, type, payload, delayMs)\` — Enqueues task after a delay

## Output Format

\`\`\`typescript // types.ts
// your types here
\`\`\`

\`\`\`typescript // queue.ts
// your queue implementation here
\`\`\`

\`\`\`typescript // worker.ts
// your worker implementation here
\`\`\`

\`\`\`typescript // scheduler.ts
// your scheduler implementation here
\`\`\``,
    keywords: [
      "enqueue", "dequeue", "priority", "pending", "processing", "completed",
      "failed", "dead", "maxRetries", "attempts", "deadLetterQueue", "DLQ",
      "Worker", "start", "stop", "processOne", "poll",
      "createTask", "createBatch", "schedule",
      "stats", "handler",
    ],
    keywordThreshold: 12,
    testExecution: true,
    testFile: "autoresearch/tests/FS002-task-queue.test.ts",
    timeoutMs: 30000,
    multiFile: true,
    fixtures: [],
  },

  {
    id: "FS003",
    category: "fullstack",
    title: "State Machine Workflow Engine with Saga Compensation",
    difficulty: "hard",
    prompt: `Build a state machine workflow engine that supports guarded transitions, side effects, and saga-pattern compensation (undo on failure).

## Your Task

Create **three files** implementing a workflow engine.

### 1. machine.ts — State Machine Core
\`\`\`typescript
interface StateDefinition {
  on: Record<string, {
    target: string;
    guard?: (context: any) => boolean;     // blocks transition if returns false
    action?: (context: any) => any;         // side effect, return value merges into context
  }>;
}

interface MachineDefinition {
  id: string;
  initial: string;
  states: Record<string, StateDefinition>;
}
\`\`\`

- \`StateMachine\` class:
  - \`constructor(definition, initialContext)\`
  - \`state\` — current state name (getter)
  - \`context\` — current context (getter)
  - \`send(event)\` — Attempts transition. Returns \`{ success, state, context }\`. Fails if: no transition defined for event, guard returns false.
  - \`canSend(event)\` — Returns boolean: is this event valid from current state?
  - \`history\` — Array of \`{ from, event, to, timestamp }\` tracking all transitions

### 2. workflow.ts — Workflow Engine
- \`WorkflowEngine\` class:
  - \`execute(steps[])\` — Runs a sequence of async steps. Each step: \`{ name, execute: (ctx) => Promise<result>, compensate: (ctx) => Promise<void> }\`
  - If a step fails, compensate all previously completed steps **in reverse order**
  - Returns \`{ success, results: Map<stepName, result>, failedStep?, error?, compensated: string[] }\`

### 3. process.ts — Example: Order Processing Workflow
- Export \`createOrderWorkflow()\` that returns a MachineDefinition:
  - States: idle → validating → payment → fulfillment → completed
  - Also: cancelled (from any state via "cancel")
  - Guards: payment only if context.amount > 0, fulfillment only if context.paid === true
  - Actions: validating sets context.validated=true, payment sets context.paid=true, fulfillment sets context.shipped=true
- Export \`createOrderSagaSteps(context)\` returning WorkflowEngine steps for: validate → charge → ship
  - Each step has a compensate (e.g., charge compensates with refund)

## Output Format

\`\`\`typescript // machine.ts
// your state machine here
\`\`\`

\`\`\`typescript // workflow.ts
// your workflow engine here
\`\`\`

\`\`\`typescript // process.ts
// your order process here
\`\`\``,
    keywords: [
      "StateMachine", "send", "guard", "action", "transition", "context", "state",
      "history", "canSend",
      "WorkflowEngine", "execute", "compensate", "reverse",
      "createOrderWorkflow", "createOrderSagaSteps",
      "idle", "validating", "payment", "fulfillment", "completed", "cancelled",
    ],
    keywordThreshold: 12,
    testExecution: true,
    testFile: "autoresearch/tests/FS003-state-machine.test.ts",
    timeoutMs: 30000,
    multiFile: true,
    fixtures: [],
  },
];
