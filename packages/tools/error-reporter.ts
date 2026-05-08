/**
 * Error reporter: captures errors with context, deduplicates, and generates
 * frequency-aware summary reports. No external dependencies.
 */

export interface CapturedError {
  id: string;
  type: string;
  message: string;
  context?: Record<string, unknown>;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
  stack?: string;
}

export interface ErrorSummary {
  total: number;
  unique: number;
  topErrors: Array<{ type: string; message: string; count: number }>;
  timespan: { firstAt: number; lastAt: number } | null;
}

function errorType(error: unknown): string {
  if (error instanceof Error) return error.constructor.name;
  if (typeof error === "string") return "StringError";
  return "UnknownError";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function dedupeKey(type: string, message: string): string {
  // Normalize numeric ids and hex values so slight variants collapse
  const normalized = message.replace(/\b\d+\b/g, "N").replace(/0x[0-9a-f]+/gi, "0xN");
  return `${type}::${normalized}`;
}

function shortId(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export class ErrorReporter {
  private readonly _errors = new Map<string, CapturedError>();

  capture(error: unknown, context?: Record<string, unknown>): CapturedError {
    const type = errorType(error);
    const message = errorMessage(error);
    const key = dedupeKey(type, message);
    const id = shortId(key);
    const now = Date.now();

    const existing = this._errors.get(id);
    if (existing) {
      existing.count += 1;
      existing.lastSeenAt = now;
      if (context) existing.context = { ...existing.context, ...context };
      return existing;
    }

    const entry: CapturedError = {
      id,
      type,
      message,
      context,
      count: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      stack: error instanceof Error ? error.stack : undefined,
    };
    this._errors.set(id, entry);
    return entry;
  }

  getErrors(): CapturedError[] {
    return Array.from(this._errors.values());
  }

  getByType(type: string): CapturedError[] {
    return this.getErrors().filter((e) => e.type === type);
  }

  /** Returns errors sorted by count descending - most frequent first. */
  frequency(): CapturedError[] {
    return this.getErrors().sort((a, b) => b.count - a.count);
  }

  /** Returns the n most recently seen errors. */
  recentErrors(n = 10): CapturedError[] {
    return this.getErrors()
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, n);
  }

  summary(): ErrorSummary {
    const all = this.getErrors();
    if (all.length === 0) {
      return { total: 0, unique: 0, topErrors: [], timespan: null };
    }

    const total = all.reduce((sum, e) => sum + e.count, 0);
    const topErrors = this.frequency()
      .slice(0, 5)
      .map((e) => ({ type: e.type, message: e.message, count: e.count }));

    const firstAt = Math.min(...all.map((e) => e.firstSeenAt));
    const lastAt = Math.max(...all.map((e) => e.lastSeenAt));

    return {
      total,
      unique: all.length,
      topErrors,
      timespan: { firstAt, lastAt },
    };
  }

  clear(): void {
    this._errors.clear();
  }
}

/** Module-level singleton for convenience. */
export const errorReporter = new ErrorReporter();
