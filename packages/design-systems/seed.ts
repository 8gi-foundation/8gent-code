/**
 * Seed Database with Design Systems from Portfolio
 *
 * Populates the SQLite database with design systems extracted from
 * James Spalding's portfolio (Myresumeportfolio).
 */

import {
  initDatabase,
  insertDesignSystemWithRelations,
  getDatabaseStats,
  closeDatabase,
} from './db';
import { EXTRACTED_THEMES, type ExtractedTheme } from './extractor';
import type { DesignStyle, DesignMood, FontCategory } from './schema';

/**
 * Generate default component configurations for a design system
 */
function generateDefaultComponents(
  systemId: string,
  style: DesignStyle
): Array<{
  component_type: string;
  variant: string;
  tailwind_classes: string;
  css_overrides: string | null;
  description: string | null;
}> {
  const components: Array<{
    component_type: string;
    variant: string;
    tailwind_classes: string;
    css_overrides: string | null;
    description: string | null;
  }> = [];

  // Button configurations based on style
  const buttonBase = 'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50';

  // Primary button
  components.push({
    component_type: 'button',
    variant: 'default',
    tailwind_classes: `${buttonBase} bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-4 py-2`,
    css_overrides: null,
    description: 'Primary action button',
  });

  // Secondary button
  components.push({
    component_type: 'button',
    variant: 'secondary',
    tailwind_classes: `${buttonBase} bg-secondary text-secondary-foreground hover:bg-secondary/80 h-10 px-4 py-2`,
    css_overrides: null,
    description: 'Secondary action button',
  });

  // Outline button
  components.push({
    component_type: 'button',
    variant: 'outline',
    tailwind_classes: `${buttonBase} border border-input bg-background hover:bg-accent hover:text-accent-foreground h-10 px-4 py-2`,
    css_overrides: null,
    description: 'Outline button',
  });

  // Ghost button
  components.push({
    component_type: 'button',
    variant: 'ghost',
    tailwind_classes: `${buttonBase} hover:bg-accent hover:text-accent-foreground h-10 px-4 py-2`,
    css_overrides: null,
    description: 'Ghost/transparent button',
  });

  // Card configurations
  const cardBase = 'rounded-lg border bg-card text-card-foreground';

  // Adjust card styling based on style
  let cardShadow = 'shadow-sm';
  if (style === 'bold' || style === 'playful') {
    cardShadow = 'shadow-lg';
  } else if (style === 'elegant') {
    cardShadow = 'shadow-md';
  }

  components.push({
    component_type: 'card',
    variant: 'default',
    tailwind_classes: `${cardBase} ${cardShadow}`,
    css_overrides: null,
    description: 'Standard card container',
  });

  // Input configurations
  components.push({
    component_type: 'input',
    variant: 'default',
    tailwind_classes: 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    css_overrides: null,
    description: 'Text input field',
  });

  // Badge configurations
  components.push({
    component_type: 'badge',
    variant: 'default',
    tailwind_classes: 'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold bg-primary text-primary-foreground',
    css_overrides: null,
    description: 'Primary badge',
  });

  components.push({
    component_type: 'badge',
    variant: 'secondary',
    tailwind_classes: 'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold bg-secondary text-secondary-foreground',
    css_overrides: null,
    description: 'Secondary badge',
  });

  components.push({
    component_type: 'badge',
    variant: 'outline',
    tailwind_classes: 'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold text-foreground',
    css_overrides: null,
    description: 'Outline badge',
  });

  return components;
}

/**
 * Convert extracted theme to database format and insert
 */
function insertTheme(theme: ExtractedTheme): void {
  const colorsJson = JSON.stringify({
    background: theme.colors.background,
    foreground: theme.colors.foreground,
    primary: theme.colors.primary,
    primaryForeground: theme.colors.primaryForeground,
    secondary: theme.colors.secondary,
    secondaryForeground: theme.colors.secondaryForeground,
    accent: theme.colors.accent,
    accentForeground: theme.colors.accentForeground,
    muted: theme.colors.muted,
    mutedForeground: theme.colors.mutedForeground,
    card: theme.colors.card,
    cardForeground: theme.colors.cardForeground,
    border: theme.colors.border,
    ring: theme.colors.ring,
  });

  const typographyJson = JSON.stringify({
    fontFamily: theme.typography.fontFamily,
    headingFont: theme.typography.headingFont,
    category: theme.typography.category,
  });

  const system = {
    id: theme.name,
    name: theme.name,
    label: theme.label,
    description: theme.description,
    style: theme.style,
    mood: theme.mood,
    colors_json: colorsJson,
    typography_json: typographyJson,
  };

  const colors = {
    name: theme.name,
    primary_hsl: theme.colors.primary,
    primary_foreground_hsl: theme.colors.primaryForeground,
    secondary_hsl: theme.colors.secondary,
    secondary_foreground_hsl: theme.colors.secondaryForeground,
    accent_hsl: theme.colors.accent,
    accent_foreground_hsl: theme.colors.accentForeground,
    background_hsl: theme.colors.background,
    foreground_hsl: theme.colors.foreground,
    muted_hsl: theme.colors.muted,
    muted_foreground_hsl: theme.colors.mutedForeground,
    card_hsl: theme.colors.card,
    card_foreground_hsl: theme.colors.cardForeground,
    border_hsl: theme.colors.border,
    ring_hsl: theme.colors.ring,
  };

  const typography = {
    font_family: theme.typography.fontFamily,
    heading_font: theme.typography.headingFont,
    font_category: theme.typography.category,
    heading_sizes_json: JSON.stringify({
      h1: '2.25rem',
      h2: '1.875rem',
      h3: '1.5rem',
      h4: '1.25rem',
      h5: '1.125rem',
      h6: '1rem',
    }),
    body_size: '1rem',
    line_height: '1.5',
    letter_spacing: 'normal',
  };

  const components = generateDefaultComponents(theme.name, theme.style);

  insertDesignSystemWithRelations(system, colors, typography, theme.tags, components);
}

/**
 * Seed the database with all extracted themes
 * @param dbPath - Optional custom database path
 * @returns Statistics about what was seeded
 */
export function seedDatabase(dbPath?: string): {
  themesSeeded: number;
  stats: ReturnType<typeof getDatabaseStats>;
} {
  // Initialize database
  initDatabase(dbPath);

  // Insert all themes
  let seeded = 0;
  for (const theme of EXTRACTED_THEMES) {
    try {
      insertTheme(theme);
      seeded++;
    } catch (error) {
      console.error(`Failed to seed theme "${theme.name}":`, error);
    }
  }

  // Get final stats
  const stats = getDatabaseStats();

  console.log(`\n=== Design Systems Database Seeded ===`);
  console.log(`Themes seeded: ${seeded}`);
  console.log(`Total design systems: ${stats.totalSystems}`);
  console.log(`Total color palettes: ${stats.totalPalettes}`);
  console.log(`Total typography configs: ${stats.totalTypography}`);
  console.log(`Total components: ${stats.totalComponents}`);
  console.log(`Total style tags: ${stats.totalTags}`);
  console.log(`=====================================\n`);

  return {
    themesSeeded: seeded,
    stats,
  };
}

// CLI execution
if (import.meta.main || require.main === module) {
  const dbPath = process.argv[2];

  console.log('Seeding design systems database...');
  if (dbPath) {
    console.log(`Using custom database path: ${dbPath}`);
  }

  try {
    const result = seedDatabase(dbPath);
    console.log('Seeding complete!');
    process.exit(0);
  } catch (error) {
    console.error('Seeding failed:', error);
    process.exit(1);
  } finally {
    closeDatabase();
  }
}
