import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

/**
 * Persistent key-value store backed by a JSON file.
 * Writes are atomic via temp-file + rename to prevent corruption on crash.
 */
export class KVStore<V extends JSONValue = JSONValue> {
  private readonly path: string;
  private data: Map<string, V>;
  private dirty = false;

  constructor(filePath: string) {
    this.path = resolve(filePath);
    this.data = new Map();
    this._load();
  }

  get(key: string): V | undefined;
  get<D extends V>(key: string, defaultValue: D): V | D;
  get(key: string, defaultValue?: V): V | undefined {
    if (this.data.has(key)) return this.data.get(key)!;
    return defaultValue;
  }

  has(key: string): boolean { return this.data.has(key); }
  keys(): string[] { return [...this.data.keys()]; }
  values(): V[] { return [...this.data.values()]; }
  entries(): [string, V][] { return [...this.data.entries()]; }
  get size(): number { return this.data.size; }

  set(key: string, value: V): this {
    this.data.set(key, value);
    this.dirty = true;
    this._save();
    return this;
  }

  delete(key: string): boolean {
    const existed = this.data.delete(key);
    if (existed) { this.dirty = true; this._save(); }
    return existed;
  }

  clear(): void {
    this.data.clear();
    this.dirty = true;
    this._save();
  }

  setMany(entries: Record<string, V>): this {
    for (const [k, v] of Object.entries(entries)) this.data.set(k, v);
    this.dirty = true;
    this._save();
    return this;
  }

  deleteMany(keys: string[]): number {
    let count = 0;
    for (const key of keys) if (this.data.delete(key)) count++;
    if (count > 0) { this.dirty = true; this._save(); }
    return count;
  }

  reload(): void { this._load(); }
  toJSON(): Record<string, V> { return Object.fromEntries(this.data); }

  private _load(): void {
    if (!existsSync(this.path)) { this.data = new Map(); return; }
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as Record<string, V>;
      this.data = new Map(Object.entries(parsed));
    } catch {
      this.data = new Map();
    }
  }

  private _save(): void {
    if (!this.dirty) return;
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = resolve(tmpdir(), "kvstore-" + randomBytes(6).toString("hex") + ".tmp");
    writeFileSync(tmp, JSON.stringify(this.toJSON(), null, 2), "utf8");
    renameSync(tmp, this.path);
    this.dirty = false;
  }
}
