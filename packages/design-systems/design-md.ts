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
// Generator - create DESIGN.md from description
// ============================================

/**
 * Font pairing presets for different project types.
 * Each preset is a curated heading + body combination.
 */
const FONT_PAIRINGS: Record<string, { heading: string; body: string; code?: string }> = {
  saas: { heading: 'Cal Sans', body: 'Inter', code: 'JetBrains Mono' },
  fintech: { heading: 'Inter', body: 'Inter', code: 'IBM Plex Mono' },
  ai: { heading: 'Inter', body: 'Inter', code: 'JetBrains Mono' },
  developer: { heading: 'Geist', body: 'Geist', code: 'Geist Mono' },
  creative: { heading: 'Fraunces', body: 'Inter' },
  agency: { heading: 'Sora', body: 'Inter' },
  ecommerce: { heading: 'DM Sans', body: 'DM Sans' },
  health: { heading: 'Plus Jakarta Sans', body: 'Plus Jakarta Sans' },
  education: { heading: 'Nunito', body: 'Nunito' },
  kids: { heading: 'Nunito', body: 'Nunito' },
  gaming: { heading: 'Space Grotesk', body: 'Inter', code: 'JetBrains Mono' },
  luxury: { heading: 'Playfair Display', body: 'Inter' },
  default: { heading: 'Inter', body: 'Inter', code: 'JetBrains Mono' },
};

/**
 * Color palette presets for different moods.
 * Returns hex colors for primary, secondary, tertiary, background, foreground.
 */
const COLOR_PRESETS: Record<string, Record<string, string>> = {
  professional: {
    primary: '#2563EB', 'on-primary': '#FFFFFF',
    secondary: '#64748B', 'on-secondary': '#FFFFFF',
    tertiary: '#10B981', 'on-tertiary': '#FFFFFF',
    background: '#FFFFFF', 'on-background': '#0F172A',
    surface: '#F8FAFC', 'on-surface': '#1E293B',
    'on-surface-variant': '#64748B',
    'surface-container': '#F1F5F9',
    outline: '#CBD5E1', 'outline-variant': '#E2E8F0',
    error: '#EF4444', 'on-error': '#FFFFFF',
  },
  warm: {
    primary: '#C2410C', 'on-primary': '#FFFFFF',
    secondary: '#92400E', 'on-secondary': '#FFFFFF',
    tertiary: '#D97706', 'on-tertiary': '#FFFFFF',
    background: '#FFFDF9', 'on-background': '#1A1612',
    surface: '#FFF8F0', 'on-surface': '#1A1612',
    'on-surface-variant': '#5C544A',
    'surface-container': '#FFF3E8',
    outline: '#E8E0D6', 'outline-variant': '#F0E8DE',
    error: '#DC2626', 'on-error': '#FFFFFF',
  },
  tech: {
    primary: '#818CF8', 'on-primary': '#1E1B4B',
    secondary: '#06B6D4', 'on-secondary': '#FFFFFF',
    tertiary: '#34D399', 'on-tertiary': '#064E3B',
    background: '#0A0A0B', 'on-background': '#FAFAFA',
    surface: '#18181B', 'on-surface': '#E4E4E7',
    'on-surface-variant': '#A1A1AA',
    'surface-container': '#27272A',
    outline: '#3F3F46', 'outline-variant': '#52525B',
    error: '#F87171', 'on-error': '#000000',
  },
  calm: {
    primary: '#047857', 'on-primary': '#FFFFFF',
    secondary: '#0891B2', 'on-secondary': '#FFFFFF',
    tertiary: '#14B8A6', 'on-tertiary': '#FFFFFF',
    background: '#FFFFFF', 'on-background': '#1E293B',
    surface: '#F0FDF4', 'on-surface': '#1E293B',
    'on-surface-variant': '#64748B',
    'surface-container': '#ECFDF5',
    outline: '#D1D5DB', 'outline-variant': '#E5E7EB',
    error: '#DC2626', 'on-error': '#FFFFFF',
  },
  energetic: {
    primary: '#E11D48', 'on-primary': '#FFFFFF',
    secondary: '#F97316', 'on-secondary': '#FFFFFF',
    tertiary: '#06B6D4', 'on-tertiary': '#FFFFFF',
    background: '#FFFFFF', 'on-background': '#0F172A',
    surface: '#FFF1F2', 'on-surface': '#1E293B',
    'on-surface-variant': '#64748B',
    'surface-container': '#FFE4E6',
    outline: '#E2E8F0', 'outline-variant': '#F1F5F9',
    error: '#DC2626', 'on-error': '#FFFFFF',
  },
  dramatic: {
    primary: '#F59E0B', 'on-primary': '#000000',
    secondary: '#EF4444', 'on-secondary': '#FFFFFF',
    tertiary: '#0EA5E9', 'on-tertiary': '#FFFFFF',
    background: '#030712', 'on-background': '#F9FAFB',
    surface: '#111827', 'on-surface': '#E5E7EB',
    'on-surface-variant': '#9CA3AF',
    'surface-container': '#1F2937',
    outline: '#374151', 'outline-variant': '#4B5563',
    error: '#F87171', 'on-error': '#000000',
  },
};

interface GenerateOptions {
  projectType?: string;
  mood?: string;
  style?: string;
  darkMode?: boolean;
  description?: string;
}

/**
 * Generate a complete DESIGN.md from a project description.
 * No design background required - the agent describes what they're building
 * and gets a spec-compliant DESIGN.md back.
 *
 * Flow:
 * 1. Check the DB for a matching design system (by project type or name)
 * 2. If found, export it as DESIGN.md
 * 3. If not, generate from presets (color palette + font pairing + spacing)
 */
export function generateDesignMd(name: string, options: GenerateOptions = {}): string {
  const projectType = options.projectType?.toLowerCase() || 'default';
  const mood = options.mood?.toLowerCase() || inferMoodFromType(projectType);
  const isDark = options.darkMode ?? (mood === 'tech' || mood === 'dramatic');

  // Try to find a matching design system in the DB first
  try {
    initDatabase();
    const existing = getDesignSystemByName(name.toLowerCase().replace(/\s+/g, '-'));
    if (existing) {
      const exported = exportDesignMd(existing.id);
      if (exported) return exported;
    }
  } catch {
    // DB not initialized, generate from presets
  }

  // Pick font pairing
  const fonts = FONT_PAIRINGS[projectType] || FONT_PAIRINGS.default!;

  // Pick color palette
  const colors = COLOR_PRESETS[mood] || COLOR_PRESETS.professional!;

  // Build DESIGN.md
  const lines: string[] = ['---'];
  lines.push(`version: alpha`);
  lines.push(`name: ${name}`);
  if (options.description) {
    lines.push(`description: ${options.description}`);
  }

  // Colors
  lines.push(`colors:`);
  for (const [key, value] of Object.entries(colors)) {
    lines.push(`  ${key}: "${value}"`);
  }

  // Typography
  lines.push(`typography:`);
  lines.push(`  display:`);
  lines.push(`    fontFamily: ${fonts.heading}`);
  lines.push(`    fontSize: 56px`);
  lines.push(`    fontWeight: 800`);
  lines.push(`    lineHeight: 1.1`);
  lines.push(`    letterSpacing: -0.03em`);
  lines.push(`  headline-lg:`);
  lines.push(`    fontFamily: ${fonts.heading}`);
  lines.push(`    fontSize: 36px`);
  lines.push(`    fontWeight: 700`);
  lines.push(`    lineHeight: 1.2`);
  lines.push(`    letterSpacing: -0.02em`);
  lines.push(`  headline-md:`);
  lines.push(`    fontFamily: ${fonts.heading}`);
  lines.push(`    fontSize: 28px`);
  lines.push(`    fontWeight: 700`);
  lines.push(`    lineHeight: 1.3`);
  lines.push(`  body-lg:`);
  lines.push(`    fontFamily: ${fonts.body}`);
  lines.push(`    fontSize: 18px`);
  lines.push(`    fontWeight: 400`);
  lines.push(`    lineHeight: 1.7`);
  lines.push(`  body-md:`);
  lines.push(`    fontFamily: ${fonts.body}`);
  lines.push(`    fontSize: 16px`);
  lines.push(`    fontWeight: 400`);
  lines.push(`    lineHeight: 1.6`);
  lines.push(`  label-lg:`);
  lines.push(`    fontFamily: ${fonts.body}`);
  lines.push(`    fontSize: 14px`);
  lines.push(`    fontWeight: 600`);
  lines.push(`    lineHeight: 1.4`);
  lines.push(`    letterSpacing: 0.01em`);
  lines.push(`  label-sm:`);
  lines.push(`    fontFamily: ${fonts.body}`);
  lines.push(`    fontSize: 12px`);
  lines.push(`    fontWeight: 500`);
  lines.push(`    lineHeight: 1.3`);
  if (fonts.code) {
    lines.push(`  code:`);
    lines.push(`    fontFamily: ${fonts.code}`);
    lines.push(`    fontSize: 14px`);
    lines.push(`    fontWeight: 400`);
    lines.push(`    lineHeight: 1.6`);
  }

  // Rounded
  lines.push(`rounded:`);
  lines.push(`  sm: 4px`);
  lines.push(`  md: 8px`);
  lines.push(`  lg: 12px`);
  lines.push(`  xl: 16px`);
  lines.push(`  2xl: 24px`);
  lines.push(`  full: 9999px`);

  // Spacing
  lines.push(`spacing:`);
  lines.push(`  xs: 4px`);
  lines.push(`  sm: 8px`);
  lines.push(`  md: 16px`);
  lines.push(`  lg: 24px`);
  lines.push(`  xl: 32px`);
  lines.push(`  2xl: 48px`);
  lines.push(`  3xl: 64px`);

  // Components
  lines.push(`components:`);
  lines.push(`  button-primary:`);
  lines.push(`    backgroundColor: "{colors.primary}"`);
  lines.push(`    textColor: "{colors.on-primary}"`);
  lines.push(`    typography: "{typography.label-lg}"`);
  lines.push(`    rounded: "{rounded.lg}"`);
  lines.push(`    padding: "{spacing.md}"`);
  lines.push(`  button-secondary:`);
  lines.push(`    backgroundColor: "{colors.surface-container}"`);
  lines.push(`    textColor: "{colors.on-surface}"`);
  lines.push(`    typography: "{typography.label-lg}"`);
  lines.push(`    rounded: "{rounded.lg}"`);
  lines.push(`    padding: "{spacing.md}"`);
  lines.push(`  card:`);
  lines.push(`    backgroundColor: "{colors.surface}"`);
  lines.push(`    rounded: "{rounded.xl}"`);
  lines.push(`    padding: "{spacing.xl}"`);
  lines.push(`  input-field:`);
  lines.push(`    backgroundColor: "{colors.surface}"`);
  lines.push(`    textColor: "{colors.on-surface}"`);
  lines.push(`    typography: "{typography.body-md}"`);
  lines.push(`    rounded: "{rounded.md}"`);
  lines.push(`    padding: "{spacing.sm}"`);
  lines.push(`  badge:`);
  lines.push(`    backgroundColor: "{colors.primary}"`);
  lines.push(`    textColor: "{colors.on-primary}"`);
  lines.push(`    typography: "{typography.label-sm}"`);
  lines.push(`    rounded: "{rounded.full}"`);
  lines.push(`    padding: "{spacing.xs}"`);

  lines.push('---');
  lines.push('');

  // Markdown prose sections
  const moodLabel = mood.charAt(0).toUpperCase() + mood.slice(1);
  const bgType = isDark ? 'dark' : 'light';

  lines.push(`## Overview`);
  lines.push('');
  lines.push(`${name} uses a ${moodLabel.toLowerCase()} visual language on a ${bgType} foundation.`);
  if (options.description) lines.push(options.description);
  lines.push('');

  lines.push(`## Colors`);
  lines.push('');
  lines.push(`- **Primary (${colors.primary}):** Main action color for CTAs, links, and active states.`);
  lines.push(`- **Secondary (${colors.secondary}):** Supporting interactions and secondary actions.`);
  if (colors.tertiary) lines.push(`- **Tertiary (${colors.tertiary}):** Accent for highlights and badges.`);
  lines.push(`- **Background (${colors.background}):** Page background.`);
  lines.push(`- **On-Background (${colors['on-background']}):** Primary text color.`);
  lines.push('');

  lines.push(`## Typography`);
  lines.push('');
  lines.push(`- **Headings:** ${fonts.heading} at bold/extrabold weights with tight letter-spacing.`);
  lines.push(`- **Body:** ${fonts.body} at regular weight with generous line heights for readability.`);
  if (fonts.code) lines.push(`- **Code:** ${fonts.code} at 14px for code blocks and inline snippets.`);
  lines.push('');

  lines.push(`## Layout & Spacing`);
  lines.push('');
  lines.push(`Content maxes at 1200px centered. 12-column grid at desktop, single column below 768px.`);
  lines.push(`Spacing uses a strict 4px base scale (4, 8, 16, 24, 32, 48, 64).`);
  lines.push('');

  lines.push(`## Elevation & Depth`);
  lines.push('');
  if (isDark) {
    lines.push(`4-level shadow scale using tonal shifts and subtle glow:`);
    lines.push(`- **Level 0:** No shadow. Flat on surface.`);
    lines.push(`- **Level 1:** \`shadow-sm\` - subtle lift for cards at rest.`);
    lines.push(`- **Level 2:** \`shadow-md shadow-primary/5\` - hover state, active cards. Primary-tinted glow.`);
    lines.push(`- **Level 3:** \`shadow-xl shadow-primary/10\` - modals, popovers, featured cards.`);
  } else {
    lines.push(`4-level shadow scale for progressive depth:`);
    lines.push(`- **Level 0:** Border only (\`border border-outline-variant\`). Cards at rest.`);
    lines.push(`- **Level 1:** \`shadow-sm\` - subtle lift on hover.`);
    lines.push(`- **Level 2:** \`shadow-lg shadow-primary/5\` - active/featured cards, dashboard panels.`);
    lines.push(`- **Level 3:** \`shadow-xl shadow-primary/10\` - modals, hero preview cards, pricing highlights.`);
  }
  lines.push(`Use shadows intentionally to create hierarchy. Hero preview cards and featured pricing tiers should use Level 2-3.`);
  lines.push('');

  lines.push(`## Shapes`);
  lines.push('');
  lines.push(`- **Buttons:** 12px radius. Substantial but not pill-shaped.`);
  lines.push(`- **Cards:** 16px radius for a modern feel.`);
  lines.push(`- **Inputs:** 8px radius for professional structure.`);
  lines.push(`- **Badges:** Full radius for pill shapes.`);
  lines.push('');

  lines.push(`## Motion & Animation`);
  lines.push('');
  lines.push(`Every section should animate into view. Use CSS animations for entrance effects:`);
  lines.push(`- **fade-in-up:** Primary entrance. Elements fade in while sliding up 20px. Duration 0.6s, ease-out.`);
  lines.push(`- **Stagger children:** Feature cards, pricing tiers, stat blocks - stagger by 100ms using animation-delay.`);
  lines.push(`- **Hover transitions:** All interactive elements use \`transition-all duration-200\`. Cards lift on hover with shadow increase.`);
  lines.push(`- **Button hover:** Primary buttons use \`hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5\`. Never just opacity.`);
  lines.push(`- **Reduced motion:** Wrap animations in \`@media (prefers-reduced-motion: no-preference)\`.`);
  lines.push('');

  lines.push(`## Effects`);
  lines.push('');
  lines.push(`- **Hero gradient:** Use a subtle radial gradient behind the hero. \`bg-gradient-to-b from-primary/5 via-background to-background\` or a radial: \`bg-[radial-gradient(ellipse_at_top,var(--color-primary)/0.08,transparent_70%)]\`.`);
  lines.push(`- **Section dividers:** Alternate between \`bg-background\` and \`bg-surface\` for visual rhythm.`);
  lines.push(`- **Glass cards (optional):** For featured elements: \`backdrop-blur-xl bg-surface/80 border border-outline-variant/50\`.`);
  lines.push(`- **Accent glow:** Hero CTA buttons can use \`shadow-lg shadow-primary/25\` for a colored glow effect.`);
  lines.push(`- **Text gradient (hero only):** Accent text can use \`bg-gradient-to-r from-primary to-tertiary bg-clip-text text-transparent\` sparingly.`);
  lines.push('');

  lines.push(`## Icons`);
  lines.push('');
  lines.push(`Use inline SVGs or Lucide React icons. NEVER use emoji characters as icons in production UI.`);
  lines.push(`Icon containers: \`flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary\`.`);
  lines.push(`If no icon library is available, use single-letter abbreviations in styled containers rather than emoji.`);
  lines.push('');

  lines.push(`## Components`);
  lines.push('');
  lines.push(`Two button variants: Primary (filled) and Secondary (surface fill). Primary reserved for the single most important action per screen.`);
  lines.push(`Cards use border-based elevation with xl rounding. On hover: \`hover:border-outline hover:shadow-lg hover:-translate-y-1 transition-all duration-200\`.`);
  lines.push(`Inputs use md rounding with surface background.`);
  lines.push(`Hero sections: use gradient background, generous vertical padding (\`py-[var(--sp-3xl)]\`), and a preview card with Level 3 shadow.`);
  lines.push('');

  lines.push(`## Tailwind v4 Usage`);
  lines.push('');
  lines.push(`### globals.css setup`);
  lines.push('');
  lines.push('Register colors and radius in @theme (Tailwind v4 auto-generates utility classes):');
  lines.push('');
  lines.push('```css');
  lines.push('@import "tailwindcss";');
  lines.push('@theme {');
  for (const [key, value] of Object.entries(colors)) {
    lines.push(`  --color-${key}: ${value};`);
  }
  lines.push(`  --radius-sm: 4px;`);
  lines.push(`  --radius-md: 8px;`);
  lines.push(`  --radius-lg: 12px;`);
  lines.push(`  --radius-xl: 16px;`);
  lines.push(`  --radius-2xl: 24px;`);
  lines.push(`  --radius-full: 9999px;`);
  lines.push('}');
  lines.push(':root {');
  lines.push('  --sp-xs: 4px; --sp-sm: 8px; --sp-md: 16px; --sp-lg: 24px;');
  lines.push('  --sp-xl: 32px; --sp-2xl: 48px; --sp-3xl: 64px;');
  lines.push('  --sp-gutter: 24px; --sp-margin: 32px;');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('Then define typography and animations in @layer utilities:');
  lines.push('');
  lines.push('```css');
  lines.push('@layer utilities {');
  lines.push(`  .type-display { font-family: "${fonts.heading}", system-ui, sans-serif; font-size: clamp(36px, 5vw, 56px); font-weight: 800; line-height: 1.1; letter-spacing: -0.03em; }`);
  lines.push(`  .type-headline-lg { font-family: "${fonts.heading}", system-ui, sans-serif; font-size: clamp(28px, 3.5vw, 36px); font-weight: 700; line-height: 1.2; letter-spacing: -0.02em; }`);
  lines.push(`  .type-headline-md { font-family: "${fonts.heading}", system-ui, sans-serif; font-size: clamp(22px, 2.5vw, 28px); font-weight: 700; line-height: 1.3; letter-spacing: -0.01em; }`);
  lines.push(`  .type-body-lg { font-family: "${fonts.body}", system-ui, sans-serif; font-size: 18px; font-weight: 400; line-height: 1.7; }`);
  lines.push(`  .type-body-md { font-family: "${fonts.body}", system-ui, sans-serif; font-size: 16px; font-weight: 400; line-height: 1.6; }`);
  lines.push(`  .type-label-lg { font-family: "${fonts.body}", system-ui, sans-serif; font-size: 14px; font-weight: 600; line-height: 1.4; letter-spacing: 0.01em; }`);
  lines.push(`  .type-label-sm { font-family: "${fonts.body}", system-ui, sans-serif; font-size: 12px; font-weight: 500; line-height: 1.3; letter-spacing: 0.02em; }`);
  if (fonts.code) {
    lines.push(`  .type-code { font-family: "${fonts.code}", monospace; font-size: 14px; font-weight: 400; line-height: 1.6; }`);
  }
  lines.push(`  .animate-fade-in-up { animation: fadeInUp 0.6s ease-out both; }`);
  lines.push(`  .animate-delay-100 { animation-delay: 100ms; }`);
  lines.push(`  .animate-delay-200 { animation-delay: 200ms; }`);
  lines.push(`  .animate-delay-300 { animation-delay: 300ms; }`);
  lines.push('}');
  lines.push('');
  lines.push('@keyframes fadeInUp {');
  lines.push('  from { opacity: 0; transform: translateY(20px); }');
  lines.push('  to { opacity: 1; transform: translateY(0); }');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('### Class mapping');
  lines.push('');
  lines.push('| Token | Tailwind class | Example |');
  lines.push('|-------|---------------|---------|');
  lines.push('| colors.primary | `bg-primary`, `text-primary`, `border-primary` | `<button className="bg-primary text-on-primary">` |');
  lines.push('| colors.on-surface-variant | `text-on-surface-variant` | `<p className="text-on-surface-variant">` |');
  lines.push('| colors.surface-container | `bg-surface-container` | `<div className="bg-surface-container">` |');
  lines.push('| rounded.lg | `rounded-lg` | `<button className="rounded-lg">` |');
  lines.push('| spacing.md | `px-[var(--sp-md)]` | `<div className="px-[var(--sp-md)]">` |');
  lines.push('| typography.display | `type-display` | `<h1 className="type-display">` |');
  lines.push('');
  lines.push('CRITICAL: spacing uses var() syntax. `px-[var(--sp-md)]` NOT `px-[--sp-md]`.');
  lines.push('CRITICAL: never use raw hex values. `bg-primary` NOT `bg-[#6366F1]`.');
  lines.push('');

  lines.push(`## Do's and Don'ts`);
  lines.push('');
  lines.push(`- Do use primary color only for the single most important CTA per screen`);
  lines.push(`- Do maintain WCAG AA contrast ratios (4.5:1 for normal text)`);
  lines.push(`- Do use the spacing scale strictly - no arbitrary pixel values`);
  lines.push(`- Do use var() when referencing spacing custom properties in arbitrary values`);
  lines.push(`- Do add \`animate-fade-in-up\` to major sections (hero, features, pricing, CTA)`);
  lines.push(`- Do stagger child animations with \`animate-delay-100\`, \`animate-delay-200\`, etc.`);
  lines.push(`- Do use SVG icons or Lucide React - never emoji characters in production UI`);
  lines.push(`- Do give hero sections a gradient background for depth`);
  lines.push(`- Do use \`transition-all duration-200\` on all interactive elements`);
  lines.push(`- Do lift cards on hover: \`hover:-translate-y-1 hover:shadow-lg\``);
  lines.push(`- Don't use more than two accent colors on any single screen`);
  lines.push(`- Don't mix heading and body fonts in the same role`);
  lines.push(`- Don't use px-[--sp-md] - must be px-[var(--sp-md)]`);
  lines.push(`- Don't use arbitrary hex colors like bg-[#6366F1] - use bg-primary`);
  lines.push(`- Don't leave sections static - every section needs an entrance animation`);
  lines.push(`- Don't use hover:opacity-90 on buttons - use hover:shadow-lg hover:-translate-y-0.5 instead`);

  return lines.join('\n');
}

function inferMoodFromType(type: string): string {
  const moodMap: Record<string, string> = {
    saas: 'professional',
    fintech: 'professional',
    ai: 'tech',
    developer: 'tech',
    gaming: 'dramatic',
    kids: 'energetic',
    creative: 'energetic',
    agency: 'dramatic',
    health: 'calm',
    wellness: 'calm',
    education: 'calm',
    luxury: 'warm',
    ecommerce: 'professional',
    food: 'warm',
    coffee: 'warm',
  };
  return moodMap[type] || 'professional';
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
