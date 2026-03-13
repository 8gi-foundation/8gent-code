import type { BenchmarkDefinition } from "../../types";

export const bugFixingBenchmarks: BenchmarkDefinition[] = [
  {
    id: "BF001",
    category: "bug-fixing",
    title: "Race Condition in Shared Counter",
    difficulty: "hard",
    prompt: `Fix the race condition in this shared counter implementation. Multiple concurrent operations must produce correct results.

\`\`\`typescript
class SharedCounter {
  private value = 0;

  async increment(): Promise<number> {
    const current = this.value;
    await new Promise(r => setTimeout(r, Math.random() * 10));
    this.value = current + 1;
    return this.value;
  }

  async decrement(): Promise<number> {
    const current = this.value;
    await new Promise(r => setTimeout(r, Math.random() * 10));
    this.value = current - 1;
    return this.value;
  }

  get(): number { return this.value; }
  reset(): void { this.value = 0; }
}
\`\`\`

Requirements:
1. After 10 concurrent increment() calls, counter MUST equal 10
2. Multiple independent counters must not interfere
3. Lock must always be released, even if operation throws
4. Provide the full corrected class as a single code block.`,
    keywords: ["lock", "mutex", "await", "release", "finally", "class", "increment", "decrement", "Promise"],
    keywordThreshold: 5,
    testExecution: true,
    testFile: "autoresearch/tests/BF001-race-condition.test.ts",
    timeoutMs: 15000,
  },
  {
    id: "BF002",
    category: "bug-fixing",
    title: "Memory Leak in Event Handler",
    difficulty: "medium",
    prompt: `Fix the memory leak in this event emitter wrapper. Handlers accumulate and are never cleaned up on destroy.

\`\`\`typescript
class JsonEventEmitter {
  private handlers: Map<string, Set<Function>> = new Map();

  on(event: string, handler: Function): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  emit(event: string, data: any): void {
    this.handlers.get(event)?.forEach(h => h(data));
  }

  // BUG: destroy doesn't clean up
  destroy(): void {
    // nothing here
  }
}
\`\`\`

Requirements:
1. destroy() must remove ALL handlers (handler count = 0 after destroy)
2. After destroy, emit() must be a no-op (no errors, no calls)
3. 1000 create/destroy cycles must not leak memory (handlers always cleaned)
4. Provide the full corrected class as a single code block.`,
    keywords: ["destroy", "clear", "delete", "handlers", "Map", "Set", "emit", "class"],
    keywordThreshold: 4,
    testExecution: true,
    testFile: "autoresearch/tests/BF002-memory-leak.test.ts",
    timeoutMs: 15000,
  },
  {
    id: "BF003",
    category: "bug-fixing",
    title: "Null Reference in Data Pipeline",
    difficulty: "easy",
    prompt: `Fix the null reference errors in this data processing pipeline. It crashes on null/undefined inputs.

\`\`\`typescript
interface DataRecord {
  id: string;
  name: string;
  email?: string;
  metadata?: Record<string, any>;
}

function processRecord(record: DataRecord): { valid: boolean; normalized: DataRecord | null; errors: string[] } {
  const errors: string[] = [];
  // BUG: crashes if record is null/undefined
  const normalized: DataRecord = {
    id: record.id.trim().toLowerCase(),
    name: record.name.trim(),
    email: record.email.trim().toLowerCase(),
    metadata: { ...record.metadata, processedAt: Date.now() },
  };

  if (!normalized.id) errors.push("missing id");
  if (!normalized.name) errors.push("missing name");
  if (normalized.email && !normalized.email.includes("@")) errors.push("invalid email");

  return { valid: errors.length === 0, normalized: errors.length === 0 ? normalized : null, errors };
}
\`\`\`

Requirements:
1. null/undefined record input must return { valid: false, normalized: null, errors: ["invalid input"] }
2. Missing/null fields must not throw — handle optional email and metadata gracefully
3. Valid records must still normalize correctly (trim, lowercase id/email)
4. Provide the full corrected function as a single code block.`,
    keywords: ["null", "undefined", "optional", "trim", "toLowerCase", "errors", "valid", "if", "return"],
    keywordThreshold: 5,
    testExecution: true,
    testFile: "autoresearch/tests/BF003-null-check.test.ts",
    timeoutMs: 10000,
  },
];
