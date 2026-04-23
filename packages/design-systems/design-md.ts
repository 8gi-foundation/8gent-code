/**
 * DESIGN.md Format Support for 8gent
 *
 * Implements the Google Labs design.md spec (Apache 2.0):
 * - Parse: DESIGN.md -> 8gent design systems DB
 * - Export: DB entry -> DESIGN.md file
 * - Lint: Validate DESIGN.md structure + tokens
 *
 * This is the design quality gate. ANY model (local Qwen, cloud Claude,
 * OpenRouter free tier) that generates UI must produce output that passes
 * the active DESIGN.md spec. The spec is model-agnostic truth.
 *
 * Concept imported from https://github.com/google-labs-code/design.md
 * Rebuilt in-house with zero external deps beyond bun:sqlite.
 */

import type {
  DesignSystem,
  DesignStyle,
  DesignMood,
  FontCategory,
} from './schema';
import {
  initDatabase,
  insertDesignSystemWithRelations,
  getDesignSystemById,
  getDesignSystemByName,
  getColorPaletteBySystemId,
  getTypographyBySystemId,
  getComponentsBySystemId,
  getTagsBySystemId,
  hslToHex,
} from './db';

// ============================================
// Types
// ============================================

export interface DesignMdTokens {
  version?: string;
  name: string;
  description?: string;
  colors?: Record<string, string>;
  typography?: Record<string, TypographyToken>;
  rounded?: Record<string, string>;
  spacing?: Record<string, string | number>;
  components?: Record<string, Record<string, string>>;
}

export interface TypographyToken {
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string | number;
  lineHeight?: string | number;
  letterSpacing?: string;
  fontFeature?: string;
  fontVariation?: string;
}

export interface DesignMdSection {
  heading: string;
  content: string;
}

export interface ParsedDesignMd {
  tokens: DesignMdTokens;
  sections: DesignMdSection[];
  raw: string;
}

export interface LintFinding {
  severity: 'error' | 'warning' | 'info';
  path?: string;
  message: string;
}

export interface LintReport {
  valid: boolean;
  findings: LintFinding[];
  summary: { errors: number; warnings: number; infos: number };
  tokens: DesignMdTokens | null;
}

// ============================================
// Parser - DESIGN.md -> structured tokens
// ============================================

/**
 * Parse a DESIGN.md file into structured tokens + sections.
 * Supports YAML frontmatter (--- delimited) only.
 * No external deps - manual YAML-subset parser for design tokens.
 */
export function parseDesignMd(content: string): ParsedDesignMd {
  const { frontmatter, body } = extractFrontmatter(content);
  const tokens = frontmatter ? parseYamlTokens(frontmatter) : { name: 'Untitled' };
  const sections = extractSections(body);

  return { tokens, sections, raw: content };
}

function extractFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    return { frontmatter: null, body: content };
  }

  const endIndex = trimmed.indexOf('\n---', 3);
  if (endIndex === -1) {
    return { frontmatter: null, body: content };
  }

  const frontmatter = trimmed.slice(4, endIndex).trim();
  const body = trimmed.slice(endIndex + 4).trim();
  return { frontmatter, body };
}

/**
 * Minimal YAML parser for design tokens.
 * Handles the subset of YAML used in DESIGN.md: scalar values, nested objects (1-2 levels).
 * No arrays, no flow syntax, no anchors/aliases needed.
 */
function parseYamlTokens(yaml: string): DesignMdTokens {
  const result: Record<string, any> = {};
  const lines = yaml.split('\n');
  let currentTopKey = '';
  let currentSubKey = '';

  for (const line of lines) {
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;
    const trimmedLine = line.trim();

    if (indent === 0) {
      // Top-level key
      const match = trimmedLine.match(/^([a-zA-Z_-]+):\s*(.*)$/);
      if (match) {
        const [, key, value] = match;
        if (value && value.trim()) {
          // Scalar value - strip quotes
          result[key!] = stripQuotes(value.trim());
        } else {
          // Start of a nested object
          result[key!] = {};
          currentTopKey = key!;
          currentSubKey = '';
        }
      }
    } else if (indent === 2 && currentTopKey) {
      // Second-level key
      const match = trimmedLine.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
      if (match) {
        const [, key, value] = match;
        if (value && value.trim()) {
          // Scalar value under top-level map
          if (typeof result[currentTopKey] !== 'object') {
            result[currentTopKey] = {};
          }
          result[currentTopKey][key!] = stripQuotes(value.trim());
          currentSubKey = '';
        } else {
          // Start of a third-level object (e.g., typography.h1)
          if (typeof result[currentTopKey] !== 'object') {
            result[currentTopKey] = {};
          }
          result[currentTopKey][key!] = {};
          currentSubKey = key!;
        }
      }
    } else if (indent === 4 && currentTopKey && currentSubKey) {
      // Third-level key (e.g., typography.h1.fontFamily)
      const match = trimmedLine.match(/^([a-zA-Z_-]+):\s*(.+)$/);
      if (match) {
        const [, key, value] = match;
        const parsed = stripQuotes(value!.trim());
        // Try to parse as number if it looks like one
        const numVal = Number(parsed);
        result[currentTopKey][currentSubKey][key!] = !isNaN(numVal) && parsed !== '' ? numVal : parsed;
      }
    }
  }

  return {
    version: result.version,
    name: result.name || 'Untitled',
    description: result.description,
    colors: result.colors,
    typography: result.typography,
    rounded: result.rounded,
    spacing: result.spacing,
    components: result.components,
  };
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function extractSections(body: string): DesignMdSection[] {
  const lines = body.split('\n');
  const sections: DesignMdSection[] = [];
  let currentHeading = '';
  let currentStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]?.match(/^## (.+)$/);
    if (match) {
      if (i > 0) {
        sections.push({
          heading: currentHeading,
          content: lines.slice(currentStart, i).join('\n').trim(),
        });
      }
      currentHeading = match[1]!;
      currentStart = i;
    }
  }

  // Push final section
  if (lines.length > 0) {
    sections.push({
      heading: currentHeading,
      content: lines.slice(currentStart).join('\n').trim(),
    });
  }

  return sections.filter(s => s.heading || s.content);
}

// ============================================
// Linter - validate DESIGN.md quality
// ============================================

const EXPECTED_SECTIONS = [
  'Overview', 'Brand & Style',
  'Colors',
  'Typography',
  'Layout', 'Layout & Spacing',
  'Elevation & Depth', 'Elevation',
  'Shapes',
  'Components',
  "Do's and Don'ts",
];

const SECTION_ORDER = [
  ['Overview', 'Brand & Style'],
  ['Colors'],
  ['Typography'],
  ['Layout', 'Layout & Spacing'],
  ['Elevation & Depth', 'Elevation'],
  ['Shapes'],
  ['Components'],
  ["Do's and Don'ts"],
];

/**
 * Lint a DESIGN.md file for structural validity and token quality.
 * This is the design quality gate - works regardless of which model generated it.
 */
export function lintDesignMd(content: string): LintReport {
  const findings: LintFinding[] = [];

  // Parse
  let parsed: ParsedDesignMd;
  try {
    parsed = parseDesignMd(content);
  } catch (err) {
    return {
      valid: false,
      findings: [{ severity: 'error', message: `Parse failed: ${err}` }],
      summary: { errors: 1, warnings: 0, infos: 0 },
      tokens: null,
    };
  }

  const { tokens, sections } = parsed;

  // Rule: name is required
  if (!tokens.name || tokens.name === 'Untitled') {
    findings.push({ severity: 'error', path: 'name', message: 'Design system must have a name' });
  }

  // Rule: primary color must exist
  if (tokens.colors) {
    if (!tokens.colors.primary) {
      findings.push({ severity: 'error', path: 'colors.primary', message: 'Primary color is required' });
    }
    // Validate all colors are hex
    for (const [key, value] of Object.entries(tokens.colors)) {
      if (!isValidHex(value)) {
        findings.push({ severity: 'error', path: `colors.${key}`, message: `Invalid hex color: "${value}"` });
      }
    }
  } else {
    findings.push({ severity: 'warning', path: 'colors', message: 'No color tokens defined' });
  }

  // Rule: typography should exist
  if (tokens.typography) {
    for (const [key, value] of Object.entries(tokens.typography)) {
      if (!value.fontFamily) {
        findings.push({ severity: 'warning', path: `typography.${key}.fontFamily`, message: `Typography "${key}" missing fontFamily` });
      }
      if (!value.fontSize) {
        findings.push({ severity: 'warning', path: `typography.${key}.fontSize`, message: `Typography "${key}" missing fontSize` });
      }
    }
  } else {
    findings.push({ severity: 'warning', path: 'typography', message: 'No typography tokens defined' });
  }

  // Rule: validate token references in components
  if (tokens.components) {
    for (const [compName, props] of Object.entries(tokens.components)) {
      for (const [propName, value] of Object.entries(props)) {
        if (isTokenRef(value)) {
          const resolved = resolveTokenRef(value, tokens);
          if (!resolved) {
            findings.push({
              severity: 'error',
              path: `components.${compName}.${propName}`,
              message: `Broken reference: ${value}`,
            });
          }
        }
      }
    }
  }

  // Rule: check section presence
  const sectionHeadings = sections.map(s => s.heading);
  const requiredSections = ['Colors', 'Typography'];
  for (const req of requiredSections) {
    const aliases = EXPECTED_SECTIONS.filter(s => s === req);
    if (!sectionHeadings.some(h => aliases.includes(h))) {
      findings.push({ severity: 'warning', path: `section.${req}`, message: `Missing recommended section: ${req}` });
    }
  }

  // Rule: check section order
  const knownSections = sectionHeadings.filter(h =>
    SECTION_ORDER.some(group => group.includes(h))
  );
  let lastOrderIndex = -1;
  for (const heading of knownSections) {
    const orderIndex = SECTION_ORDER.findIndex(group => group.includes(heading));
    if (orderIndex < lastOrderIndex) {
      findings.push({
        severity: 'warning',
        path: `section.${heading}`,
        message: `Section "${heading}" is out of recommended order`,
      });
    }
    lastOrderIndex = Math.max(lastOrderIndex, orderIndex);
  }

  // Rule: check for duplicate sections
  const seen = new Set<string>();
  for (const heading of sectionHeadings) {
    if (heading && seen.has(heading)) {
      findings.push({ severity: 'error', path: `section.${heading}`, message: `Duplicate section: ${heading}` });
    }
    seen.add(heading);
  }

  // Rule: contrast check (basic - primary vs background if both exist)
  if (tokens.colors?.primary && tokens.colors?.background) {
    const ratio = contrastRatio(tokens.colors.primary, tokens.colors.background);
    if (ratio !== null && ratio < 4.5) {
      findings.push({
        severity: 'warning',
        path: 'colors.contrast',
        message: `Primary/background contrast ratio ${ratio.toFixed(2)} is below WCAG AA (4.5:1)`,
      });
    }
  }

  const errors = findings.filter(f => f.severity === 'error').length;
  const warnings = findings.filter(f => f.severity === 'warning').length;
  const infos = findings.filter(f => f.severity === 'info').length;

  return {
    valid: errors === 0,
    findings,
    summary: { errors, warnings, infos },
    tokens,
  };
}

// ============================================
// Importer - DESIGN.md -> DB
// ============================================

/**
 * Import a DESIGN.md file into the design systems database.
 * Maps the design.md token format to 8gent's schema.
 */
export function importDesignMd(content: string, overrides?: {
  style?: DesignStyle;
  mood?: DesignMood;
  tags?: string[];
}): { id: string; name: string; findings: LintFinding[] } {
  const report = lintDesignMd(content);
  if (!report.tokens) {
    throw new Error(`Cannot import: ${report.findings[0]?.message || 'parse failed'}`);
  }

  const tokens = report.tokens;
  const id = slugify(tokens.name);
  const style = overrides?.style || inferStyle(tokens);
  const mood = overrides?.mood || inferMood(tokens);

  // Map design.md hex colors to HSL for the DB
  const colorMap = tokens.colors || {};
  const hslColors = {
    primary_hsl: hexToHsl(colorMap.primary || '#000000'),
    primary_foreground_hsl: hexToHsl(colorMap['on-primary'] || colorMap['primary-foreground'] || '#ffffff'),
    secondary_hsl: hexToHsl(colorMap.secondary || colorMap.neutral || '#666666'),
    secondary_foreground_hsl: hexToHsl(colorMap['on-secondary'] || '#ffffff'),
    accent_hsl: hexToHsl(colorMap.tertiary || colorMap.accent || colorMap.primary || '#000000'),
    accent_foreground_hsl: hexToHsl(colorMap['on-tertiary'] || '#ffffff'),
    background_hsl: hexToHsl(colorMap.background || colorMap.surface || colorMap.neutral || '#ffffff'),
    foreground_hsl: hexToHsl(colorMap['on-background'] || colorMap['on-surface'] || colorMap.primary || '#000000'),
    muted_hsl: hexToHsl(colorMap['surface-container'] || colorMap['surface-dim'] || '#f0f0f0'),
    muted_foreground_hsl: hexToHsl(colorMap['on-surface-variant'] || '#666666'),
    card_hsl: hexToHsl(colorMap['surface-container-lowest'] || colorMap.surface || '#ffffff'),
    card_foreground_hsl: hexToHsl(colorMap['on-surface'] || '#000000'),
    border_hsl: hexToHsl(colorMap.outline || colorMap['outline-variant'] || '#cccccc'),
    ring_hsl: hexToHsl(colorMap.primary || '#000000'),
  };

  // Map typography
  const typoEntries = tokens.typography ? Object.entries(tokens.typography) : [];
  const headingEntry = typoEntries.find(([k]) => k.includes('headline') || k.includes('display') || k === 'h1');
  const bodyEntry = typoEntries.find(([k]) => k.includes('body'));

  const typography = {
    font_family: bodyEntry?.[1]?.fontFamily || headingEntry?.[1]?.fontFamily || 'Inter',
    heading_font: headingEntry?.[1]?.fontFamily || bodyEntry?.[1]?.fontFamily || 'Inter',
    font_category: inferFontCategory(bodyEntry?.[1]?.fontFamily || 'Inter') as FontCategory,
    heading_sizes_json: JSON.stringify(
      Object.fromEntries(
        typoEntries
          .filter(([k]) => k.includes('h') || k.includes('headline') || k.includes('display'))
          .map(([k, v]) => [k, v.fontSize || '1rem'])
      )
    ),
    body_size: bodyEntry?.[1]?.fontSize || '16px',
    line_height: String(bodyEntry?.[1]?.lineHeight || '1.5'),
    letter_spacing: bodyEntry?.[1]?.letterSpacing || 'normal',
  };

  // Extract tags from sections and token names
  const tags = overrides?.tags || inferTags(tokens);

  // Map components
  const components = tokens.components
    ? Object.entries(tokens.components).map(([name, props]) => ({
        component_type: name.split('-')[0] || name,
        variant: name.includes('-') ? name.split('-').slice(1).join('-') : 'default',
        tailwind_classes: componentPropsToTailwind(props, tokens),
        css_overrides: null as string | null,
        description: `${name} component from DESIGN.md`,
      }))
    : [];

  initDatabase();
  insertDesignSystemWithRelations(
    {
      id,
      name: tokens.name,
      label: tokens.name,
      description: tokens.description || `Imported from DESIGN.md`,
      style,
      mood,
      colors_json: JSON.stringify({
        background: colorMap.background || colorMap.surface || '#ffffff',
        foreground: colorMap['on-background'] || colorMap['on-surface'] || '#000000',
        primary: colorMap.primary || '#000000',
        primaryForeground: colorMap['on-primary'] || '#ffffff',
        secondary: colorMap.secondary || '#666666',
        secondaryForeground: colorMap['on-secondary'] || '#ffffff',
        accent: colorMap.tertiary || colorMap.accent || '#000000',
        accentForeground: colorMap['on-tertiary'] || '#ffffff',
        muted: colorMap['surface-container'] || '#f0f0f0',
        mutedForeground: colorMap['on-surface-variant'] || '#666666',
        card: colorMap['surface-container-lowest'] || '#ffffff',
        cardForeground: colorMap['on-surface'] || '#000000',
        border: colorMap.outline || '#cccccc',
        ring: colorMap.primary || '#000000',
      }),
      typography_json: JSON.stringify({
        fontFamily: typography.font_family,
        headingFont: typography.heading_font,
        category: typography.font_category,
      }),
    },
    hslColors,
    typography,
    tags,
    components
  );

  return { id, name: tokens.name, findings: report.findings };
}

// ============================================
// Exporter - DB -> DESIGN.md
// ============================================

/**
 * Export a design system from the DB as a DESIGN.md file.
 * Generates both YAML frontmatter tokens and markdown prose sections.
 */
export function exportDesignMd(idOrName: string): string | null {
  initDatabase();

  let system: DesignSystem | undefined;
  system = getDesignSystemById(idOrName);
  if (!system) system = getDesignSystemByName(idOrName);
  if (!system) return null;

  const palette = getColorPaletteBySystemId(system.id);
  const typography = getTypographyBySystemId(system.id);
  const components = getComponentsBySystemId(system.id);
  const tags = getTagsBySystemId(system.id);

  const lines: string[] = ['---'];

  // Frontmatter
  lines.push(`version: alpha`);
  lines.push(`name: ${system.label}`);
  if (system.description) {
    lines.push(`description: ${system.description}`);
  }

  // Colors
  if (palette) {
    lines.push(`colors:`);
    const colorEntries: [string, string][] = [
      ['primary', hslToHex(palette.primary_hsl)],
      ['on-primary', hslToHex(palette.primary_foreground_hsl)],
      ['secondary', hslToHex(palette.secondary_hsl)],
      ['on-secondary', hslToHex(palette.secondary_foreground_hsl)],
      ['tertiary', hslToHex(palette.accent_hsl)],
      ['on-tertiary', hslToHex(palette.accent_foreground_hsl)],
      ['background', hslToHex(palette.background_hsl)],
      ['on-background', hslToHex(palette.foreground_hsl)],
      ['surface', hslToHex(palette.card_hsl)],
      ['on-surface', hslToHex(palette.card_foreground_hsl)],
      ['outline', hslToHex(palette.border_hsl)],
    ];
    for (const [name, hex] of colorEntries) {
      lines.push(`  ${name}: "${hex}"`);
    }
  }

  // Typography
  if (typography) {
    lines.push(`typography:`);
    const headingSizes = typography.heading_sizes_json
      ? JSON.parse(typography.heading_sizes_json)
      : {};

    // Generate heading entries
    for (const [key, size] of Object.entries(headingSizes)) {
      lines.push(`  ${key}:`);
      lines.push(`    fontFamily: ${typography.heading_font}`);
      lines.push(`    fontSize: ${size}`);
      lines.push(`    fontWeight: 700`);
    }

    // Body entry
    lines.push(`  body-md:`);
    lines.push(`    fontFamily: ${typography.font_family}`);
    lines.push(`    fontSize: ${typography.body_size}`);
    lines.push(`    fontWeight: 400`);
    lines.push(`    lineHeight: ${typography.line_height}`);
    if (typography.letter_spacing !== 'normal') {
      lines.push(`    letterSpacing: ${typography.letter_spacing}`);
    }
  }

  // Components
  if (components.length > 0) {
    lines.push(`components:`);
    for (const comp of components) {
      const key = comp.variant === 'default'
        ? comp.component_type
        : `${comp.component_type}-${comp.variant}`;
      lines.push(`  ${key}:`);
      if (comp.description) {
        lines.push(`    # ${comp.description}`);
      }
      // Parse tailwind classes back to token-like properties
      lines.push(`    tailwind: "${comp.tailwind_classes}"`);
    }
  }

  lines.push('---');
  lines.push('');

  // Markdown body
  lines.push(`## Overview`);
  lines.push('');
  lines.push(`${system.label} is a ${system.style} design system with a ${system.mood} mood.`);
  if (system.description) {
    lines.push(`${system.description}`);
  }
  if (tags.length > 0) {
    lines.push(`Tags: ${tags.join(', ')}`);
  }
  lines.push('');

  // Colors section
  if (palette) {
    lines.push(`## Colors`);
    lines.push('');
    lines.push(`- **Primary (${hslToHex(palette.primary_hsl)}):** The core brand color.`);
    lines.push(`- **Secondary (${hslToHex(palette.secondary_hsl)}):** Supporting color for secondary actions.`);
    lines.push(`- **Accent (${hslToHex(palette.accent_hsl)}):** Highlight and interaction color.`);
    lines.push(`- **Background (${hslToHex(palette.background_hsl)}):** Page background.`);
    lines.push('');
  }

  // Typography section
  if (typography) {
    lines.push(`## Typography`);
    lines.push('');
    lines.push(`- **Headings:** ${typography.heading_font}`);
    lines.push(`- **Body:** ${typography.font_family} at ${typography.body_size}`);
    lines.push('');
  }

  // Components section
  if (components.length > 0) {
    lines.push(`## Components`);
    lines.push('');
    for (const comp of components) {
      lines.push(`- **${comp.component_type}** (${comp.variant}): ${comp.description || comp.tailwind_classes}`);
    }
    lines.push('');
  }

  // Do's and Don'ts
  lines.push(`## Do's and Don'ts`);
  lines.push('');
  lines.push(`- Do use the primary color for the most important action per screen`);
  lines.push(`- Do maintain WCAG AA contrast ratios (4.5:1 for normal text)`);
  lines.push(`- Don't mix more than two font families`);
  lines.push(`- Don't use colors outside the defined palette`);

  return lines.join('\n');
}

/**
 * Generate a DESIGN.md spec string suitable for injection into any model's
 * system prompt. This is the model-agnostic design quality gate.
 */
export function generateDesignSpec(idOrName: string): string | null {
  const md = exportDesignMd(idOrName);
  if (!md) return null;

  return [
    '# Active Design System',
    '',
    'The following DESIGN.md defines the visual identity for this project.',
    'ALL UI code MUST conform to these tokens. Do not invent colors, fonts,',
    'or spacing values outside this spec. Reference tokens by name.',
    '',
    md,
  ].join('\n');
}

// ============================================
// Helpers
// ============================================

function isValidHex(value: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value);
}

function isTokenRef(value: string): boolean {
  return /^\{[a-zA-Z0-9._-]+\}$/.test(value);
}

function resolveTokenRef(ref: string, tokens: DesignMdTokens): string | null {
  // Extract path: "{colors.primary}" -> ["colors", "primary"]
  // Also handles composite refs: "{typography.label-md}" -> returns the object (valid per spec)
  const path = ref.slice(1, -1).split('.');
  let current: any = tokens;
  for (const segment of path) {
    if (current && typeof current === 'object' && segment in current) {
      current = current[segment];
    } else {
      return null;
    }
  }
  // Primitives resolve to string, composite objects (like typography entries) also resolve
  if (typeof current === 'string' || typeof current === 'number') return String(current);
  if (typeof current === 'object' && current !== null) return '[composite]';
  return null;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function inferStyle(tokens: DesignMdTokens): DesignStyle {
  const colors = tokens.colors || {};
  const colorCount = Object.keys(colors).length;
  if (colorCount <= 5) return 'minimal';
  if (colorCount > 20) return 'bold';
  return 'tech';
}

function inferMood(tokens: DesignMdTokens): DesignMood {
  const bg = tokens.colors?.background || tokens.colors?.surface || '#ffffff';
  // Dark backgrounds = tech/dramatic, light = professional/warm
  const brightness = hexBrightness(bg);
  if (brightness < 50) return 'tech';
  if (brightness > 200) return 'professional';
  return 'warm';
}

function inferTags(tokens: DesignMdTokens): string[] {
  const tags: string[] = [];
  const name = tokens.name.toLowerCase();

  if (tokens.colors?.primary) tags.push('has-primary');
  if (tokens.typography) tags.push('has-typography');
  if (tokens.components) tags.push('has-components');
  if (tokens.rounded) tags.push('has-rounded');
  if (tokens.spacing) tags.push('has-spacing');

  // Infer from name
  const keywords = ['dark', 'light', 'minimal', 'bold', 'playful', 'modern', 'classic', 'elegant'];
  for (const kw of keywords) {
    if (name.includes(kw)) tags.push(kw);
  }

  tags.push('design-md-import');
  return tags;
}

function inferFontCategory(fontFamily: string): string {
  const lower = fontFamily.toLowerCase();
  if (lower.includes('mono') || lower.includes('code') || lower.includes('jetbrains')) return 'monospace';
  if (lower.includes('serif') && !lower.includes('sans')) return 'serif';
  if (lower.includes('display') || lower.includes('fraunces')) return 'display';
  return 'sans-serif';
}

function componentPropsToTailwind(props: Record<string, string>, tokens: DesignMdTokens): string {
  const classes: string[] = [];
  for (const [key, value] of Object.entries(props)) {
    const resolved = isTokenRef(value) ? resolveTokenRef(value, tokens) : value;
    if (!resolved) continue;

    // Map common properties to approximate Tailwind classes
    if (key === 'rounded' && resolved.includes('px')) {
      const px = parseInt(resolved);
      if (px <= 4) classes.push('rounded-sm');
      else if (px <= 8) classes.push('rounded');
      else if (px <= 12) classes.push('rounded-lg');
      else if (px <= 16) classes.push('rounded-xl');
      else classes.push('rounded-full');
    }
  }
  return classes.join(' ') || 'rounded-md';
}

/**
 * Convert hex color to HSL string (for DB storage).
 * Returns "H S% L%" format matching the existing schema.
 */
function hexToHsl(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return '0 0% 0%';

  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) {
    return `0 0% ${Math.round(l * 100)}%`;
  }

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;

  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.replace('#', '');
  let r: number, g: number, b: number;

  if (clean.length === 3) {
    r = parseInt(clean[0]! + clean[0]!, 16);
    g = parseInt(clean[1]! + clean[1]!, 16);
    b = parseInt(clean[2]! + clean[2]!, 16);
  } else if (clean.length >= 6) {
    r = parseInt(clean.slice(0, 2), 16);
    g = parseInt(clean.slice(2, 4), 16);
    b = parseInt(clean.slice(4, 6), 16);
  } else {
    return null;
  }

  return { r, g, b };
}

function hexBrightness(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 128;
  return (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000;
}

/**
 * Calculate WCAG contrast ratio between two hex colors.
 */
function contrastRatio(hex1: string, hex2: string): number | null {
  const rgb1 = hexToRgb(hex1);
  const rgb2 = hexToRgb(hex2);
  if (!rgb1 || !rgb2) return null;

  const lum1 = relativeLuminance(rgb1.r, rgb1.g, rgb1.b);
  const lum2 = relativeLuminance(rgb2.r, rgb2.g, rgb2.b);

  const lighter = Math.max(lum1, lum2);
  const darker = Math.min(lum1, lum2);

  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(r: number, g: number, b: number): number {
  const srgb = [r / 255, g / 255, b / 255].map(c =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  );
  return 0.2126 * srgb[0]! + 0.7152 * srgb[1]! + 0.0722 * srgb[2]!;
}
