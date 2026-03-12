/**
 * SQLite Schema for Design Systems Database
 * Extracted from James Spalding's Portfolio Design System
 */

export const SCHEMA = `
-- Design Systems Table
-- Core registry of design systems/themes
CREATE TABLE IF NOT EXISTS design_systems (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  description TEXT,
  style TEXT NOT NULL,  -- 'minimal' | 'bold' | 'playful' | 'elegant' | 'tech' | 'retro' | 'nature'
  mood TEXT NOT NULL,   -- 'professional' | 'creative' | 'tech' | 'warm' | 'cool' | 'dramatic'
  colors_json TEXT NOT NULL,      -- JSON: { background, foreground, primary, accent, etc. }
  typography_json TEXT NOT NULL,  -- JSON: { fontFamily, headingFont, etc. }
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Color Palettes Table
-- Extracted color values for each design system
CREATE TABLE IF NOT EXISTS color_palettes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- HSL values stored as strings (e.g., "220 80% 55%")
  primary_hsl TEXT NOT NULL,
  primary_foreground_hsl TEXT NOT NULL,
  secondary_hsl TEXT NOT NULL,
  secondary_foreground_hsl TEXT NOT NULL,
  accent_hsl TEXT NOT NULL,
  accent_foreground_hsl TEXT NOT NULL,
  background_hsl TEXT NOT NULL,
  foreground_hsl TEXT NOT NULL,
  muted_hsl TEXT NOT NULL,
  muted_foreground_hsl TEXT NOT NULL,
  card_hsl TEXT NOT NULL,
  card_foreground_hsl TEXT NOT NULL,
  border_hsl TEXT NOT NULL,
  ring_hsl TEXT NOT NULL,
  FOREIGN KEY (system_id) REFERENCES design_systems(id) ON DELETE CASCADE
);

-- Typography Table
-- Font configurations for each design system
CREATE TABLE IF NOT EXISTS typography (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id TEXT NOT NULL,
  font_family TEXT NOT NULL,        -- Primary body font
  heading_font TEXT NOT NULL,       -- Heading font (can be same as body)
  font_category TEXT NOT NULL,      -- 'sans-serif' | 'serif' | 'monospace' | 'display' | 'cursive'
  heading_sizes_json TEXT,          -- JSON: { h1: "3rem", h2: "2.25rem", etc. }
  body_size TEXT DEFAULT '1rem',
  line_height TEXT DEFAULT '1.5',
  letter_spacing TEXT DEFAULT 'normal',
  FOREIGN KEY (system_id) REFERENCES design_systems(id) ON DELETE CASCADE
);

-- Components Table
-- Common UI component configurations per design system
CREATE TABLE IF NOT EXISTS components (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id TEXT NOT NULL,
  component_type TEXT NOT NULL,     -- 'button' | 'card' | 'input' | 'badge' | 'dialog' | etc.
  variant TEXT DEFAULT 'default',   -- 'default' | 'outline' | 'ghost' | etc.
  tailwind_classes TEXT NOT NULL,   -- Tailwind class string
  css_overrides TEXT,               -- Optional custom CSS
  description TEXT,
  FOREIGN KEY (system_id) REFERENCES design_systems(id) ON DELETE CASCADE
);

-- Style Tags (for searching)
CREATE TABLE IF NOT EXISTS style_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  FOREIGN KEY (system_id) REFERENCES design_systems(id) ON DELETE CASCADE
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_design_systems_style ON design_systems(style);
CREATE INDEX IF NOT EXISTS idx_design_systems_mood ON design_systems(mood);
CREATE INDEX IF NOT EXISTS idx_color_palettes_system ON color_palettes(system_id);
CREATE INDEX IF NOT EXISTS idx_typography_system ON typography(system_id);
CREATE INDEX IF NOT EXISTS idx_components_system ON components(system_id);
CREATE INDEX IF NOT EXISTS idx_components_type ON components(component_type);
CREATE INDEX IF NOT EXISTS idx_style_tags_system ON style_tags(system_id);
CREATE INDEX IF NOT EXISTS idx_style_tags_tag ON style_tags(tag);
`;

// TypeScript types for the schema
export interface DesignSystem {
  id: string;
  name: string;
  label: string;
  description: string | null;
  style: DesignStyle;
  mood: DesignMood;
  colors_json: string;
  typography_json: string;
  created_at: string;
  updated_at: string;
}

export interface ColorPalette {
  id: number;
  system_id: string;
  name: string;
  primary_hsl: string;
  primary_foreground_hsl: string;
  secondary_hsl: string;
  secondary_foreground_hsl: string;
  accent_hsl: string;
  accent_foreground_hsl: string;
  background_hsl: string;
  foreground_hsl: string;
  muted_hsl: string;
  muted_foreground_hsl: string;
  card_hsl: string;
  card_foreground_hsl: string;
  border_hsl: string;
  ring_hsl: string;
}

export interface Typography {
  id: number;
  system_id: string;
  font_family: string;
  heading_font: string;
  font_category: FontCategory;
  heading_sizes_json: string | null;
  body_size: string;
  line_height: string;
  letter_spacing: string;
}

export interface Component {
  id: number;
  system_id: string;
  component_type: string;
  variant: string;
  tailwind_classes: string;
  css_overrides: string | null;
  description: string | null;
}

export interface StyleTag {
  id: number;
  system_id: string;
  tag: string;
}

export type DesignStyle =
  | 'minimal'
  | 'bold'
  | 'playful'
  | 'elegant'
  | 'tech'
  | 'retro'
  | 'nature'
  | 'corporate';

export type DesignMood =
  | 'professional'
  | 'creative'
  | 'tech'
  | 'warm'
  | 'cool'
  | 'dramatic'
  | 'calm'
  | 'energetic';

export type FontCategory =
  | 'sans-serif'
  | 'serif'
  | 'monospace'
  | 'display'
  | 'cursive';

// Parsed color object
export interface ParsedColors {
  background: string;
  foreground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  accent: string;
  accentForeground: string;
  muted: string;
  mutedForeground: string;
  card: string;
  cardForeground: string;
  border: string;
  ring: string;
}

// Parsed typography object
export interface ParsedTypography {
  fontFamily: string;
  headingFont: string;
  category: FontCategory;
}
