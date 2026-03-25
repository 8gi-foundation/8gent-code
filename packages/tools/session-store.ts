import { existsSync, readFileSync, writeFileSync } from "fs";

interface Entry<T> {
  value: T;
  expiresAt: number | null;
  namespace: string;
}

interface SerializedStore {
  entries: Record<string, Entry<unknown>>;
}

export class SessionStore {
  private entries = new Map<string, Entry<unknown>>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private persistPath: string | null = null;
  private defaultNamespace: string;

  constructor(options: {
    persistPath?: string;
    cleanupIntervalMs?: number;
    defaultNamespace?: string;
  } = {}) {
    this.defaultNamespace = options.defaultNamespace ?? "default";
    this.persistPath = options.persistPath ?? null;

    if (this.persistPath) {
      this.load();
    }

    const intervalMs = options.cleanupIntervalMs ?? 60_000;
    this.cleanupInterval = setInterval(() => this.cleanup(), intervalMs);
    if (typeof (this.cleanupInterval as NodeJS.Timeout).unref === "function") {
      (this.cleanupInterval as NodeJS.Timeout).unref();
    }
  }

  private key(k: string, ns: string): string {
    return `${ns}::${k}`;
  }

  set<T>(
    k: string,
    value: T,
    options: { ttlMs?: number; namespace?: string } = {}
  ): void {
    const ns = options.namespace ?? this.defaultNamespace;
    const expiresAt = options.ttlMs != null ? Date.now() + options.ttlMs : null;
    this.entries.set(this.key(k, ns), { value, expiresAt, namespace: ns });
  }

  get<T>(k: string, namespace?: string): T | undefined {
    const ns = namespace ?? this.defaultNamespace;
    const entry = this.entries.get(this.key(k, ns));
    if (!entry) return undefined;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.entries.delete(this.key(k, ns));
      return undefined;
    }
    return entry.value as T;
  }

  has(k: string, namespace?: string): boolean {
    return this.get(k, namespace) !== undefined;
  }

  delete(k: string, namespace?: string): boolean {
    const ns = namespace ?? this.defaultNamespace;
    return this.entries.delete(this.key(k, ns));
  }

  keys(namespace?: string): string[] {
    const ns = namespace ?? this.defaultNamespace;
    const prefix = `${ns}::`;
    const result: string[] = [];
    for (const [composite, entry] of this.entries) {
      if (!composite.startsWith(prefix)) continue;
      if (entry.expiresAt !== null && Date.now() > entry.expiresAt) continue;
      result.push(composite.slice(prefix.length));
    }
    return result;
  }

  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [k, entry] of this.entries) {
      if (entry.expiresAt !== null && now > entry.expiresAt) {
        this.entries.delete(k);
        removed++;
      }
    }
    return removed;
  }

  save(path?: string): void {
    const target = path ?? this.persistPath;
    if (!target) throw new Error("No persist path configured");
    this.cleanup();
    const data: SerializedStore = { entries: Object.fromEntries(this.entries) };
    writeFileSync(target, JSON.stringify(data, null, 2), "utf8");
  }

  load(path?: string): void {
    const target = path ?? this.persistPath;
    if (!target || !existsSync(target)) return;
    try {
      const raw = readFileSync(target, "utf8");
      const data: SerializedStore = JSON.parse(raw);
      const now = Date.now();
      for (const [k, entry] of Object.entries(data.entries)) {
        if (entry.expiresAt !== null && now > entry.expiresAt) continue;
        this.entries.set(k, entry as Entry<unknown>);
      }
    } catch {
      // Corrupted file - start fresh
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  get size(): number {
    this.cleanup();
    return this.entries.size;
  }
}
