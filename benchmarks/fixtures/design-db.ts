/**
 * SQLite Design System Database — Fixture for FS-MEGA-001
 *
 * Uses Bun's built-in bun:sqlite (zero dependencies).
 * Provides a typed wrapper around a design system database.
 */
import { Database as BunDB } from "bun:sqlite";

export class DesignDB {
  db: BunDB;

  constructor(path: string = ":memory:") {
    this.db = new BunDB(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  /** Run raw SQL */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  /** Run a query returning rows */
  query<T = any>(sql: string, params?: any[]): T[] {
    const stmt = this.db.prepare(sql);
    return (params ? stmt.all(...params) : stmt.all()) as T[];
  }

  /** Run a query returning a single row */
  queryOne<T = any>(sql: string, params?: any[]): T | null {
    const stmt = this.db.prepare(sql);
    return (params ? stmt.get(...params) : stmt.get()) as T | null;
  }

  /** Insert and return lastInsertRowid */
  insert(sql: string, params?: any[]): number {
    const stmt = this.db.prepare(sql);
    const result = params ? stmt.run(...params) : stmt.run();
    return Number(result.lastInsertRowid);
  }

  /** Run a mutation (UPDATE/DELETE), return changes count */
  mutate(sql: string, params?: any[]): number {
    const stmt = this.db.prepare(sql);
    const result = params ? stmt.run(...params) : stmt.run();
    return result.changes;
  }

  /** Check if a table exists */
  tableExists(name: string): boolean {
    const row = this.queryOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name=?",
      [name]
    );
    return (row?.count ?? 0) > 0;
  }

  /** Close the database */
  close(): void {
    this.db.close();
  }
}

// ── Convenience Types ───────────────────────────────────────────────

export interface DesignTokenRow {
  id: number;
  category: string;    // "color" | "spacing" | "typography" | "shadow" | "radius" | "size"
  name: string;        // "primary" | "sm" | "heading-1"
  value: string;       // "#3B82F6" | "8px" | "{ fontSize: 24, fontWeight: 700 }"
  description?: string;
  is_reference: number; // 0 or 1 — if 1, value is a $reference to another token
  created_at: string;
  updated_at: string;
}

export interface ComponentRow {
  id: number;
  name: string;           // "Button" | "Card" | "Input"
  category: string;       // "action" | "layout" | "form" | "display"
  description?: string;
  props_schema: string;   // JSON: { propName: { type, required, default } }
  default_styles: string; // JSON: resolved CSS properties
  created_at: string;
  updated_at: string;
}

export interface VariantRow {
  id: number;
  component_id: number;
  name: string;          // "primary" | "secondary" | "outline" | "ghost"
  styles: string;        // JSON: CSS overrides for this variant
  description?: string;
}

export interface ThemeRow {
  id: number;
  name: string;          // "light" | "dark" | "custom"
  base_theme_id?: number; // inherits from this theme
  description?: string;
  created_at: string;
}

export interface ThemeTokenRow {
  id: number;
  theme_id: number;
  token_id: number;
  override_value: string; // the overridden value for this token in this theme
}

/**
 * Generate a unique ID string (for tests that need string IDs).
 */
export function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
