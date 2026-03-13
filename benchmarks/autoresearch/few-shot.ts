import type { BenchmarkCategory } from "../types";

/**
 * One worked example per benchmark category.
 * Injected between system prompt and task to guide free-tier models.
 * Each example is ~200-400 tokens — enough to prime the format without
 * blowing the context budget.
 */

const FEW_SHOT_EXAMPLES: Record<BenchmarkCategory, string> = {
  "bug-fixing": `<example>
TASK: Fix the race condition in this async counter that loses updates.

\`\`\`typescript
class BrokenCounter {
  private n = 0;
  async add(x: number) {
    const cur = this.n;
    await delay(1);
    this.n = cur + x; // lost update
  }
}
\`\`\`

SOLUTION:
\`\`\`typescript
class FixedCounter {
  private n = 0;
  private lock = Promise.resolve();

  async add(x: number): Promise<void> {
    // Serialize access with a promise chain (mutex pattern)
    this.lock = this.lock.then(async () => {
      this.n += x;
    });
    await this.lock;
  }

  get(): number { return this.n; }
}
\`\`\`

KEY INSIGHT: The bug is a classic read-modify-write race. The fix serializes access with a promise-chain mutex so only one operation touches \`this.n\` at a time. Always use \`finally\` or chaining to guarantee lock release.
</example>`,

  "file-manipulation": `<example>
TASK: Validate that an email string is well-formed.

\`\`\`typescript
function validateEmail(email: string): { valid: boolean; error?: string } {
  // implement
}
\`\`\`

SOLUTION:
\`\`\`typescript
function validateEmail(email: string): { valid: boolean; error?: string } {
  if (!email || typeof email !== "string") {
    return { valid: false, error: "email is required" };
  }
  const trimmed = email.trim();
  if (trimmed.length === 0) return { valid: false, error: "email is empty" };
  if (!trimmed.includes("@"))  return { valid: false, error: "missing @" };
  if (trimmed.includes(" "))   return { valid: false, error: "contains spaces" };

  const [local, domain] = trimmed.split("@");
  if (!local || !domain || !domain.includes(".")) {
    return { valid: false, error: "invalid format" };
  }
  return { valid: true };
}
\`\`\`

KEY INSIGHT: Always guard against null/undefined/empty inputs first, then validate structure. Return structured error objects, not thrown exceptions, so callers can aggregate multiple validation results.
</example>`,

  "feature-implementation": `<example>
TASK: Implement a simple key-value cache with a max size and LRU eviction.

\`\`\`typescript
class SimpleCache<V> {
  constructor(private maxSize: number) {}
  get(key: string): V | undefined { /* implement */ }
  set(key: string, value: V): void { /* implement */ }
}
\`\`\`

SOLUTION:
\`\`\`typescript
class SimpleCache<V> {
  private store = new Map<string, V>();

  constructor(private maxSize: number) {}

  get(key: string): V | undefined {
    const val = this.store.get(key);
    if (val === undefined) return undefined;
    // Promote to most-recent by re-inserting
    this.store.delete(key);
    this.store.set(key, val);
    return val;
  }

  set(key: string, value: V): void {
    // Delete first so re-insert goes to end
    this.store.delete(key);
    if (this.store.size >= this.maxSize) {
      // Evict oldest (first key in insertion-order Map)
      const oldest = this.store.keys().next().value!;
      this.store.delete(oldest);
    }
    this.store.set(key, value);
  }
}
\`\`\`

KEY INSIGHT: JavaScript Maps maintain insertion order. Use delete-then-set to promote an entry to most-recent. The first key (\`keys().next().value\`) is always the least-recently-used. This gives O(1) LRU without a doubly-linked list.
</example>`,

  "fullstack": `<example>
TASK: Given an existing Router and Database, build a TODO API with CRUD operations across multiple files.

SOLUTION:

\`\`\`typescript // types.ts
export interface Todo {
  id: string;
  title: string;
  done: boolean;
  createdAt: number;
}
\`\`\`

\`\`\`typescript // routes.ts
import { Router, makeRequest } from "./http";
import { Database, generateId } from "./database";
import type { Todo } from "./types";

export function registerRoutes(router: Router, db: Database) {
  router.post("/todos", (req) => {
    if (!req.body?.title) return { status: 400, headers: {}, body: { error: "title required" } };
    const todo: Todo = { id: generateId(), title: req.body.title, done: false, createdAt: Date.now() };
    db.put("todos", todo.id, todo);
    return { status: 200, headers: {}, body: todo };
  });

  router.get("/todos", () => {
    return { status: 200, headers: {}, body: db.list("todos") };
  });
}
\`\`\`

\`\`\`typescript // app.ts
import { Router } from "./http";
import { Database } from "./database";
import { registerRoutes } from "./routes";

export function createApp() {
  const db = new Database();
  const router = new Router();
  registerRoutes(router, db);
  return { router, db };
}
export default createApp;
\`\`\`

KEY INSIGHT: For multi-file tasks, output EACH file in a separate fenced block with the filename: \\\`\\\`\\\`typescript // filename.ts. Import from fixture files (database.ts, http.ts) using relative imports. Export a createApp() that wires everything together — tests will call it to get the router and db.
</example>`,

  "agentic": `<example>
TASK: Build a topological sort with cycle detection for dependency resolution.

SOLUTION:

\`\`\`typescript // resolver.ts
interface Node { name: string; deps: string[] }

export function resolve(nodes: Node[]): string[] {
  const graph = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const n of nodes) {
    graph.set(n.name, n.deps);
    if (!inDegree.has(n.name)) inDegree.set(n.name, 0);
    for (const d of n.deps) {
      inDegree.set(d, (inDegree.get(d) ?? 0) + 1);
    }
  }

  // Kahn's algorithm
  const queue = [...inDegree.entries()].filter(([, deg]) => deg === 0).map(([n]) => n);
  const order: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);
    for (const dep of graph.get(current) ?? []) {
      const newDeg = (inDegree.get(dep) ?? 1) - 1;
      inDegree.set(dep, newDeg);
      if (newDeg === 0) queue.push(dep);
    }
  }

  if (order.length !== inDegree.size) {
    throw new Error("Circular dependency detected");
  }
  return order.reverse(); // deps first
}
export default resolve;
\`\`\`

KEY INSIGHT: For agentic tasks, think architecturally. Use well-known algorithms (Kahn's for topological sort, AC-3 for constraint propagation). Handle edge cases defensively — cycle detection, empty inputs, missing optional deps. Always export both named AND default. For multi-file tasks, each file must import its dependencies with relative paths.
</example>`,

  "ui-design": `<example>
TASK: Create a neumorphic button with soft shadows and a pressed state.

SOLUTION:
\`\`\`html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Neumorphic Button</title>
  <style>
    body {
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background-color: #e0e5ec;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }

    .btn {
      padding: 16px 40px;
      border: none;
      border-radius: 12px;
      background-color: #e0e5ec;
      color: #333;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      box-shadow:
        6px 6px 12px rgba(163, 177, 198, 0.6),
        -6px -6px 12px rgba(255, 255, 255, 0.8);
      transition: all 0.3s ease;
    }

    .btn:hover {
      box-shadow:
        4px 4px 8px rgba(163, 177, 198, 0.6),
        -4px -4px 8px rgba(255, 255, 255, 0.8);
    }

    .btn:active, .btn.pressed {
      box-shadow:
        inset 4px 4px 8px rgba(163, 177, 198, 0.6),
        inset -4px -4px 8px rgba(255, 255, 255, 0.8);
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  </style>
</head>
<body>
  <button class="btn">Click Me</button>
</body>
</html>
\`\`\`

KEY INSIGHT: Neumorphic design uses TWO box-shadows (one light, one dark) on a matching background to create a soft 3D raised effect. The pressed state inverts these with the \`inset\` keyword. Always use rgba colors — not hex — for shadow control. Output COMPLETE HTML with embedded <style> in a single file. No external CSS frameworks.
</example>`,

  "battle-test": `<example>
TASK: Build an auth system with JWT tokens, role-based access, rate limiting, and user storage.

SOLUTION:

\`\`\`typescript // auth.ts
import { createHmac, randomBytes, pbkdf2Sync } from "crypto";

export type Role = "admin" | "editor" | "viewer" | "billing";

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return \`\${salt}:\${hash}\`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  const verify = pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return hash === verify;
}

export function generateToken(
  payload: { userId: string; role: Role; email: string },
  secret: string,
  expiresIn: number = 3600000
): string {
  const header = { alg: "HS256", typ: "JWT" };
  const body = { ...payload, iat: Date.now(), exp: Date.now() + expiresIn };
  const h = Buffer.from(JSON.stringify(header)).toString("base64url");
  const b = Buffer.from(JSON.stringify(body)).toString("base64url");
  const sig = createHmac("sha256", secret).update(\`\${h}.\${b}\`).digest("base64url");
  return \`\${h}.\${b}.\${sig}\`;
}

export function verifyToken(token: string, secret: string) {
  const [h, b, sig] = token.split(".");
  const expected = createHmac("sha256", secret).update(\`\${h}.\${b}\`).digest("base64url");
  if (sig !== expected) return null;
  const payload = JSON.parse(Buffer.from(b, "base64url").toString());
  if (payload.exp < Date.now()) return null;
  return payload;
}

export function generateRefreshToken(): string { return randomBytes(32).toString("hex"); }
export function generateResetCode(): string { return String(Math.floor(100000 + Math.random() * 900000)); }
\`\`\`

\`\`\`typescript // rbac.ts
export type Role = "admin" | "editor" | "viewer" | "billing";
export type Permission = "read" | "write" | "delete" | "manage_users" | "manage_billing" | "view_analytics";

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ["read", "write", "delete", "manage_users", "manage_billing", "view_analytics"],
  editor: ["read", "write", "view_analytics"],
  viewer: ["read"],
  billing: ["read", "manage_billing", "view_analytics"],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
\`\`\`

KEY INSIGHT: For multi-file battle-test tasks, output EACH file in a separate fenced block with the filename: \\\`\\\`\\\`typescript // filename.ts. Use built-in crypto (no external deps). Export all types, classes, and functions. Always include both named AND default exports. Test with edge cases: expired tokens, duplicate emails, rate limit boundaries.
</example>`,
};

/**
 * Return the few-shot block for a category, or empty string if none.
 */
export function getFewShot(category: BenchmarkCategory): string {
  return FEW_SHOT_EXAMPLES[category] ?? "";
}

/**
 * All available few-shot categories.
 */
export function listFewShotCategories(): BenchmarkCategory[] {
  return Object.keys(FEW_SHOT_EXAMPLES) as BenchmarkCategory[];
}
