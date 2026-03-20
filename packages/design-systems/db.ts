/**
 * SQLite Database Operations for Design Systems
 * Uses bun:sqlite for synchronous operations (built-in, no native deps)
 */

import { Database } from 'bun:sqlite';
import path from 'path';
import fs from 'fs';
import { SCHEMA } from './schema';
import type {
  DesignSystem,
  ColorPalette,
  Typography,
  Component,
  StyleTag,
  DesignStyle,
  DesignMood,
  ParsedColors,
  ParsedTypography,
} from './schema';

// Default database path
const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'design-systems.db');

let db: Database | null = null;

/**
 * Initialize the database connection and create tables
 */
export function initDatabase(dbPath: string = DEFAULT_DB_PATH): Database {
  // Ensure data directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  // Run schema
  db.exec(SCHEMA);

  return db;
}

/**
 * Get the current database instance
 */
export function getDatabase(): Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ============================================
// Design Systems CRUD Operations
// ============================================

export function insertDesignSystem(system: Omit<DesignSystem, 'created_at' | 'updated_at'>): void {
  const stmt = getDatabase().prepare(`
    INSERT OR REPLACE INTO design_systems
    (id, name, label, description, style, mood, colors_json, typography_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    system.id,
    system.name,
    system.label,
    system.description,
    system.style,
    system.mood,
    system.colors_json,
    system.typography_json
  );
}

export function getDesignSystemById(id: string): DesignSystem | undefined {
  const stmt = getDatabase().prepare('SELECT * FROM design_systems WHERE id = ?');
  return stmt.get(id) as DesignSystem | undefined;
}

export function getDesignSystemByName(name: string): DesignSystem | undefined {
  const stmt = getDatabase().prepare('SELECT * FROM design_systems WHERE name = ?');
  return stmt.get(name) as DesignSystem | undefined;
}

export function getAllDesignSystems(): DesignSystem[] {
  const stmt = getDatabase().prepare('SELECT * FROM design_systems ORDER BY name');
  return stmt.all() as DesignSystem[];
}

export function getDesignSystemsByStyle(style: DesignStyle): DesignSystem[] {
  const stmt = getDatabase().prepare('SELECT * FROM design_systems WHERE style = ?');
  return stmt.all(style) as DesignSystem[];
}

export function getDesignSystemsByMood(mood: DesignMood): DesignSystem[] {
  const stmt = getDatabase().prepare('SELECT * FROM design_systems WHERE mood = ?');
  return stmt.all(mood) as DesignSystem[];
}

// ============================================
// Color Palettes CRUD Operations
// ============================================

export function insertColorPalette(palette: Omit<ColorPalette, 'id'>): number {
  const stmt = getDatabase().prepare(`
    INSERT INTO color_palettes
    (system_id, name, primary_hsl, primary_foreground_hsl, secondary_hsl,
     secondary_foreground_hsl, accent_hsl, accent_foreground_hsl,
     background_hsl, foreground_hsl, muted_hsl, muted_foreground_hsl,
     card_hsl, card_foreground_hsl, border_hsl, ring_hsl)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    palette.system_id,
    palette.name,
    palette.primary_hsl,
    palette.primary_foreground_hsl,
    palette.secondary_hsl,
    palette.secondary_foreground_hsl,
    palette.accent_hsl,
    palette.accent_foreground_hsl,
    palette.background_hsl,
    palette.foreground_hsl,
    palette.muted_hsl,
    palette.muted_foreground_hsl,
    palette.card_hsl,
    palette.card_foreground_hsl,
    palette.border_hsl,
    palette.ring_hsl
  );

  // bun:sqlite doesn't expose lastInsertRowid on run result the same way
  const result = getDatabase().prepare('SELECT last_insert_rowid() as id').get() as { id: number };
  return result.id;
}

export function getColorPaletteBySystemId(systemId: string): ColorPalette | undefined {
  const stmt = getDatabase().prepare('SELECT * FROM color_palettes WHERE system_id = ?');
  return stmt.get(systemId) as ColorPalette | undefined;
}

// ============================================
// Typography CRUD Operations
// ============================================

export function insertTypography(typography: Omit<Typography, 'id'>): number {
  const stmt = getDatabase().prepare(`
    INSERT INTO typography
    (system_id, font_family, heading_font, font_category, heading_sizes_json,
     body_size, line_height, letter_spacing)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    typography.system_id,
    typography.font_family,
    typography.heading_font,
    typography.font_category,
    typography.heading_sizes_json,
    typography.body_size,
    typography.line_height,
    typography.letter_spacing
  );

  const result = getDatabase().prepare('SELECT last_insert_rowid() as id').get() as { id: number };
  return result.id;
}

export function getTypographyBySystemId(systemId: string): Typography | undefined {
  const stmt = getDatabase().prepare('SELECT * FROM typography WHERE system_id = ?');
  return stmt.get(systemId) as Typography | undefined;
}

// ============================================
// Components CRUD Operations
// ============================================

export function insertComponent(component: Omit<Component, 'id'>): number {
  const stmt = getDatabase().prepare(`
    INSERT INTO components
    (system_id, component_type, variant, tailwind_classes, css_overrides, description)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    component.system_id,
    component.component_type,
    component.variant,
    component.tailwind_classes,
    component.css_overrides,
    component.description
  );

  const result = getDatabase().prepare('SELECT last_insert_rowid() as id').get() as { id: number };
  return result.id;
}

export function getComponentsBySystemId(systemId: string): Component[] {
  const stmt = getDatabase().prepare('SELECT * FROM components WHERE system_id = ?');
  return stmt.all(systemId) as Component[];
}

export function getComponentByType(
  systemId: string,
  componentType: string,
  variant: string = 'default'
): Component | undefined {
  const stmt = getDatabase().prepare(
    'SELECT * FROM components WHERE system_id = ? AND component_type = ? AND variant = ?'
  );
  return stmt.get(systemId, componentType, variant) as Component | undefined;
}

// ============================================
// Style Tags CRUD Operations
// ============================================

export function insertStyleTag(systemId: string, tag: string): number {
  const stmt = getDatabase().prepare(
    'INSERT INTO style_tags (system_id, tag) VALUES (?, ?)'
  );
  stmt.run(systemId, tag);
  const result = getDatabase().prepare('SELECT last_insert_rowid() as id').get() as { id: number };
  return result.id;
}

export function getTagsBySystemId(systemId: string): string[] {
  const stmt = getDatabase().prepare('SELECT tag FROM style_tags WHERE system_id = ?');
  const rows = stmt.all(systemId) as { tag: string }[];
  return rows.map((r) => r.tag);
}

export function getSystemsByTag(tag: string): DesignSystem[] {
  const stmt = getDatabase().prepare(`
    SELECT ds.* FROM design_systems ds
    INNER JOIN style_tags st ON ds.id = st.system_id
    WHERE st.tag = ?
  `);
  return stmt.all(tag) as DesignSystem[];
}

// ============================================
// Full-text search
// ============================================

export function searchDesignSystems(query: string): DesignSystem[] {
  const pattern = `%${query.toLowerCase()}%`;
  const stmt = getDatabase().prepare(`
    SELECT DISTINCT ds.* FROM design_systems ds
    LEFT JOIN style_tags st ON ds.id = st.system_id
    WHERE LOWER(ds.name) LIKE ?
       OR LOWER(ds.label) LIKE ?
       OR LOWER(ds.description) LIKE ?
       OR LOWER(ds.style) LIKE ?
       OR LOWER(ds.mood) LIKE ?
       OR LOWER(st.tag) LIKE ?
    ORDER BY ds.name
  `);
  return stmt.all(pattern, pattern, pattern, pattern, pattern, pattern) as DesignSystem[];
}

// ============================================
// Batch Operations
// ============================================

export function insertDesignSystemWithRelations(
  system: Omit<DesignSystem, 'created_at' | 'updated_at'>,
  colors: Omit<ColorPalette, 'id' | 'system_id'>,
  typography: Omit<Typography, 'id' | 'system_id'>,
  tags: string[],
  components?: Omit<Component, 'id' | 'system_id'>[]
): void {
  const database = getDatabase();
  const transaction = database.transaction(() => {
    // Insert design system
    insertDesignSystem(system);

    // Insert color palette
    insertColorPalette({ ...colors, system_id: system.id, name: system.name });

    // Insert typography
    insertTypography({ ...typography, system_id: system.id });

    // Insert tags
    for (const tag of tags) {
      insertStyleTag(system.id, tag);
    }

    // Insert components if provided
    if (components) {
      for (const component of components) {
        insertComponent({ ...component, system_id: system.id });
      }
    }
  });

  transaction();
}

// ============================================
// Helper Functions
// ============================================

export function parseColorsJson(json: string): ParsedColors {
  return JSON.parse(json);
}

export function parseTypographyJson(json: string): ParsedTypography {
  return JSON.parse(json);
}

export function hslToHex(hsl: string): string {
  // Parse HSL string like "220 80% 55%"
  const parts = hsl.split(' ').map((p) => parseFloat(p.replace('%', '')));
  if (parts.length < 3) return '#000000';

  const h = parts[0];
  const s = parts[1] / 100;
  const l = parts[2] / 100;

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let r = 0,
    g = 0,
    b = 0;

  if (h >= 0 && h < 60) {
    r = c;
    g = x;
    b = 0;
  } else if (h >= 60 && h < 120) {
    r = x;
    g = c;
    b = 0;
  } else if (h >= 120 && h < 180) {
    r = 0;
    g = c;
    b = x;
  } else if (h >= 180 && h < 240) {
    r = 0;
    g = x;
    b = c;
  } else if (h >= 240 && h < 300) {
    r = x;
    g = 0;
    b = c;
  } else if (h >= 300 && h < 360) {
    r = c;
    g = 0;
    b = x;
  }

  const toHex = (n: number) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, '0');

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Get database statistics
 */
export function getDatabaseStats(): {
  totalSystems: number;
  totalPalettes: number;
  totalTypography: number;
  totalComponents: number;
  totalTags: number;
} {
  const database = getDatabase();
  return {
    totalSystems: (
      database.prepare('SELECT COUNT(*) as count FROM design_systems').get() as {
        count: number;
      }
    ).count,
    totalPalettes: (
      database.prepare('SELECT COUNT(*) as count FROM color_palettes').get() as {
        count: number;
      }
    ).count,
    totalTypography: (
      database.prepare('SELECT COUNT(*) as count FROM typography').get() as {
        count: number;
      }
    ).count,
    totalComponents: (
      database.prepare('SELECT COUNT(*) as count FROM components').get() as {
        count: number;
      }
    ).count,
    totalTags: (
      database.prepare('SELECT COUNT(*) as count FROM style_tags').get() as {
        count: number;
      }
    ).count,
  };
}
