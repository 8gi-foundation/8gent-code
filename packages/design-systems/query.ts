/**
 * Query Interface for 8gent
 * High-level query functions for finding and suggesting design systems
 */

import {
  initDatabase,
  getDatabase,
  closeDatabase,
  getAllDesignSystems,
  getDesignSystemsByStyle,
  getDesignSystemsByMood,
  getDesignSystemById,
  getDesignSystemByName,
  searchDesignSystems,
  getColorPaletteBySystemId,
  getTypographyBySystemId,
  getComponentsBySystemId,
  getTagsBySystemId,
  getSystemsByTag,
  parseColorsJson,
  parseTypographyJson,
  hslToHex,
  getDatabaseStats,
} from './db';

import type {
  DesignSystem,
  DesignStyle,
  DesignMood,
  ColorPalette,
  Typography,
  Component,
  ParsedColors,
  ParsedTypography,
} from './schema';

// Re-export types
export type {
  DesignSystem,
  DesignStyle,
  DesignMood,
  ColorPalette,
  Typography,
  Component,
  ParsedColors,
  ParsedTypography,
};

// Re-export database functions
export {
  initDatabase,
  closeDatabase,
  getDatabaseStats,
};

/**
 * Complete design system with all related data
 */
export interface CompleteDesignSystem {
  system: DesignSystem;
  colors: ColorPalette | null;
  typography: Typography | null;
  components: Component[];
  tags: string[];
  parsedColors: ParsedColors | null;
  parsedTypography: ParsedTypography | null;
}

/**
 * Design suggestion with reasoning
 */
export interface DesignSuggestion {
  system: CompleteDesignSystem;
  score: number;
  reasoning: string[];
}

// ============================================
// Core Query Functions
// ============================================

/**
 * Get all design systems
 */
export function listAll(): DesignSystem[] {
  return getAllDesignSystems();
}

/**
 * Get a complete design system by ID or name
 */
export function getComplete(idOrName: string): CompleteDesignSystem | null {
  let system = getDesignSystemById(idOrName);
  if (!system) {
    system = getDesignSystemByName(idOrName);
  }
  if (!system) {
    return null;
  }

  const colors = getColorPaletteBySystemId(system.id);
  const typography = getTypographyBySystemId(system.id);
  const components = getComponentsBySystemId(system.id);
  const tags = getTagsBySystemId(system.id);

  return {
    system,
    colors: colors || null,
    typography: typography || null,
    components,
    tags,
    parsedColors: system.colors_json ? parseColorsJson(system.colors_json) : null,
    parsedTypography: system.typography_json
      ? parseTypographyJson(system.typography_json)
      : null,
  };
}

/**
 * Find design systems by style
 * @param style - 'minimal' | 'bold' | 'playful' | 'elegant' | 'tech' | 'retro' | 'nature' | 'corporate'
 */
export function findByStyle(style: DesignStyle): DesignSystem[] {
  return getDesignSystemsByStyle(style);
}

/**
 * Find design systems by mood
 * @param mood - 'professional' | 'creative' | 'tech' | 'warm' | 'cool' | 'dramatic' | 'calm' | 'energetic'
 */
export function findByMood(mood: DesignMood): DesignSystem[] {
  return getDesignSystemsByMood(mood);
}

/**
 * Find design systems by tag
 */
export function findByTag(tag: string): DesignSystem[] {
  return getSystemsByTag(tag);
}

/**
 * Search design systems by text query
 */
export function search(query: string): DesignSystem[] {
  return searchDesignSystems(query);
}

// ============================================
// Suggestion Functions
// ============================================

/**
 * Project type to style/mood mapping
 */
const PROJECT_TYPE_MAPPINGS: Record<
  string,
  { styles: DesignStyle[]; moods: DesignMood[]; tags: string[] }
> = {
  // AI/Chat Applications
  ai: {
    styles: ['minimal', 'tech'],
    moods: ['professional', 'tech'],
    tags: ['ai', 'chat', 'conversational', 'assistant'],
  },
  chatbot: {
    styles: ['minimal', 'tech'],
    moods: ['professional', 'tech', 'warm'],
    tags: ['ai', 'chat', 'conversational'],
  },
  assistant: {
    styles: ['minimal', 'elegant'],
    moods: ['professional', 'warm'],
    tags: ['ai', 'assistant', 'helpful'],
  },

  // Developer Tools
  developer: {
    styles: ['tech', 'minimal'],
    moods: ['tech', 'professional'],
    tags: ['developer', 'code', 'monospace', 'tech'],
  },
  code: {
    styles: ['tech'],
    moods: ['tech'],
    tags: ['code', 'developer', 'monospace', 'editor'],
  },
  documentation: {
    styles: ['minimal', 'elegant'],
    moods: ['professional'],
    tags: ['documentation', 'clean', 'readable'],
  },

  // Business/Corporate
  enterprise: {
    styles: ['corporate', 'minimal'],
    moods: ['professional'],
    tags: ['corporate', 'business', 'professional', 'brand'],
  },
  saas: {
    styles: ['minimal', 'tech'],
    moods: ['professional', 'tech'],
    tags: ['saas', 'modern', 'clean', 'professional'],
  },
  startup: {
    styles: ['bold', 'tech'],
    moods: ['energetic', 'creative'],
    tags: ['startup', 'modern', 'bold', 'innovative'],
  },
  fintech: {
    styles: ['minimal', 'corporate'],
    moods: ['professional', 'tech'],
    tags: ['finance', 'professional', 'trust', 'clean'],
  },

  // Creative
  portfolio: {
    styles: ['elegant', 'minimal', 'bold'],
    moods: ['creative', 'professional'],
    tags: ['portfolio', 'creative', 'artistic', 'personal'],
  },
  creative: {
    styles: ['bold', 'playful'],
    moods: ['creative', 'energetic'],
    tags: ['creative', 'artistic', 'colorful', 'bold'],
  },
  agency: {
    styles: ['bold', 'elegant'],
    moods: ['creative', 'professional'],
    tags: ['agency', 'creative', 'modern', 'bold'],
  },
  art: {
    styles: ['elegant', 'bold'],
    moods: ['creative', 'dramatic'],
    tags: ['art', 'artistic', 'gallery', 'visual'],
  },

  // Consumer
  ecommerce: {
    styles: ['minimal', 'corporate'],
    moods: ['professional', 'warm'],
    tags: ['shop', 'store', 'commerce', 'clean'],
  },
  blog: {
    styles: ['elegant', 'minimal'],
    moods: ['calm', 'warm'],
    tags: ['blog', 'reading', 'content', 'serif'],
  },
  social: {
    styles: ['playful', 'bold'],
    moods: ['energetic', 'creative'],
    tags: ['social', 'community', 'fun', 'engaging'],
  },

  // Specific Verticals
  health: {
    styles: ['nature', 'minimal'],
    moods: ['calm', 'warm'],
    tags: ['health', 'wellness', 'calm', 'organic'],
  },
  wellness: {
    styles: ['nature', 'elegant'],
    moods: ['calm', 'warm'],
    tags: ['wellness', 'calm', 'nature', 'organic'],
  },
  gaming: {
    styles: ['bold', 'retro'],
    moods: ['dramatic', 'energetic'],
    tags: ['gaming', 'game', 'arcade', 'neon'],
  },
  education: {
    styles: ['minimal', 'playful'],
    moods: ['calm', 'professional'],
    tags: ['education', 'learning', 'clean', 'accessible'],
  },
  kids: {
    styles: ['playful'],
    moods: ['energetic'],
    tags: ['kids', 'playful', 'colorful', 'fun'],
  },
  food: {
    styles: ['nature', 'elegant'],
    moods: ['warm'],
    tags: ['food', 'restaurant', 'organic', 'warm'],
  },
  coffee: {
    styles: ['nature'],
    moods: ['warm'],
    tags: ['coffee', 'cafe', 'cozy', 'warm', 'brown'],
  },
  luxury: {
    styles: ['elegant'],
    moods: ['professional', 'warm'],
    tags: ['luxury', 'premium', 'elegant', 'gold'],
  },
  tech: {
    styles: ['tech', 'minimal'],
    moods: ['tech', 'professional'],
    tags: ['tech', 'technology', 'modern', 'innovative'],
  },
  nature: {
    styles: ['nature'],
    moods: ['calm'],
    tags: ['nature', 'organic', 'green', 'earth'],
  },
  space: {
    styles: ['bold'],
    moods: ['dramatic', 'cool'],
    tags: ['space', 'cosmic', 'dark', 'futuristic'],
  },
};

/**
 * Suggest design systems for a project type
 * @param projectType - Type of project (e.g., 'ai', 'saas', 'portfolio', 'gaming')
 * @param options - Additional filtering options
 */
export function suggestForProject(
  projectType: string,
  options?: {
    preferDark?: boolean;
    preferLight?: boolean;
    maxResults?: number;
  }
): DesignSuggestion[] {
  const maxResults = options?.maxResults ?? 5;
  const normalizedType = projectType.toLowerCase().trim();

  // Get mapping or use default
  const mapping = PROJECT_TYPE_MAPPINGS[normalizedType] ?? {
    styles: ['minimal'] as DesignStyle[],
    moods: ['professional'] as DesignMood[],
    tags: [],
  };

  const suggestions: DesignSuggestion[] = [];
  const seenIds = new Set<string>();

  // Score all systems
  const allSystems = getAllDesignSystems();

  for (const system of allSystems) {
    if (seenIds.has(system.id)) continue;

    let score = 0;
    const reasoning: string[] = [];

    // Style match (highest weight)
    if (mapping.styles.includes(system.style as DesignStyle)) {
      score += 30;
      reasoning.push(`Style "${system.style}" matches ${normalizedType} projects`);
    }

    // Mood match (high weight)
    if (mapping.moods.includes(system.mood as DesignMood)) {
      score += 25;
      reasoning.push(`Mood "${system.mood}" suits ${normalizedType} applications`);
    }

    // Tag matches
    const systemTags = getTagsBySystemId(system.id);
    const matchingTags = systemTags.filter((tag) =>
      mapping.tags.some(
        (mt) => tag.toLowerCase().includes(mt) || mt.includes(tag.toLowerCase())
      )
    );

    if (matchingTags.length > 0) {
      score += matchingTags.length * 10;
      reasoning.push(`Tags "${matchingTags.join(', ')}" relevant to ${normalizedType}`);
    }

    // Only include if there's some match
    if (score > 0) {
      seenIds.add(system.id);

      const complete = getComplete(system.id);
      if (complete) {
        suggestions.push({
          system: complete,
          score,
          reasoning,
        });
      }
    }
  }

  // Sort by score descending
  suggestions.sort((a, b) => b.score - a.score);

  return suggestions.slice(0, maxResults);
}

/**
 * Find similar design systems to a given one
 */
export function findSimilar(systemId: string, maxResults: number = 5): DesignSystem[] {
  const source = getDesignSystemById(systemId);
  if (!source) return [];

  const allSystems = getAllDesignSystems();
  const sourceTags = getTagsBySystemId(systemId);

  const scored = allSystems
    .filter((s) => s.id !== systemId)
    .map((system) => {
      let score = 0;

      // Same style
      if (system.style === source.style) score += 20;

      // Same mood
      if (system.mood === source.mood) score += 15;

      // Overlapping tags
      const systemTags = getTagsBySystemId(system.id);
      const overlap = systemTags.filter((t) => sourceTags.includes(t)).length;
      score += overlap * 5;

      return { system, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, maxResults).map((s) => s.system);
}

// ============================================
// CSS Generation
// ============================================

/**
 * Generate CSS variables for a design system
 */
export function generateCssVariables(systemId: string): string | null {
  const palette = getColorPaletteBySystemId(systemId);
  const typo = getTypographyBySystemId(systemId);

  if (!palette) return null;

  const lines = [
    `:root {`,
    `  --theme-background: ${palette.background_hsl};`,
    `  --theme-foreground: ${palette.foreground_hsl};`,
    `  --theme-card: ${palette.card_hsl};`,
    `  --theme-card-foreground: ${palette.card_foreground_hsl};`,
    `  --theme-primary: ${palette.primary_hsl};`,
    `  --theme-primary-foreground: ${palette.primary_foreground_hsl};`,
    `  --theme-secondary: ${palette.secondary_hsl};`,
    `  --theme-secondary-foreground: ${palette.secondary_foreground_hsl};`,
    `  --theme-muted: ${palette.muted_hsl};`,
    `  --theme-muted-foreground: ${palette.muted_foreground_hsl};`,
    `  --theme-accent: ${palette.accent_hsl};`,
    `  --theme-accent-foreground: ${palette.accent_foreground_hsl};`,
    `  --theme-border: ${palette.border_hsl};`,
    `  --theme-ring: ${palette.ring_hsl};`,
  ];

  if (typo) {
    lines.push(`  --theme-font: ${typo.font_family};`);
    lines.push(`  --theme-font-heading: ${typo.heading_font};`);
  }

  lines.push(`}`);

  return lines.join('\n');
}

/**
 * Generate Tailwind theme config for a design system
 */
export function generateTailwindConfig(systemId: string): object | null {
  const palette = getColorPaletteBySystemId(systemId);

  if (!palette) return null;

  return {
    colors: {
      background: `hsl(${palette.background_hsl})`,
      foreground: `hsl(${palette.foreground_hsl})`,
      card: {
        DEFAULT: `hsl(${palette.card_hsl})`,
        foreground: `hsl(${palette.card_foreground_hsl})`,
      },
      primary: {
        DEFAULT: `hsl(${palette.primary_hsl})`,
        foreground: `hsl(${palette.primary_foreground_hsl})`,
      },
      secondary: {
        DEFAULT: `hsl(${palette.secondary_hsl})`,
        foreground: `hsl(${palette.secondary_foreground_hsl})`,
      },
      muted: {
        DEFAULT: `hsl(${palette.muted_hsl})`,
        foreground: `hsl(${palette.muted_foreground_hsl})`,
      },
      accent: {
        DEFAULT: `hsl(${palette.accent_hsl})`,
        foreground: `hsl(${palette.accent_foreground_hsl})`,
      },
      border: `hsl(${palette.border_hsl})`,
      ring: `hsl(${palette.ring_hsl})`,
    },
  };
}

/**
 * Get hex color palette for a design system
 */
export function getHexPalette(
  systemId: string
): Record<string, string> | null {
  const palette = getColorPaletteBySystemId(systemId);
  if (!palette) return null;

  return {
    background: hslToHex(palette.background_hsl),
    foreground: hslToHex(palette.foreground_hsl),
    card: hslToHex(palette.card_hsl),
    cardForeground: hslToHex(palette.card_foreground_hsl),
    primary: hslToHex(palette.primary_hsl),
    primaryForeground: hslToHex(palette.primary_foreground_hsl),
    secondary: hslToHex(palette.secondary_hsl),
    secondaryForeground: hslToHex(palette.secondary_foreground_hsl),
    muted: hslToHex(palette.muted_hsl),
    mutedForeground: hslToHex(palette.muted_foreground_hsl),
    accent: hslToHex(palette.accent_hsl),
    accentForeground: hslToHex(palette.accent_foreground_hsl),
    border: hslToHex(palette.border_hsl),
    ring: hslToHex(palette.ring_hsl),
  };
}

// ============================================
// Quick Access Functions
// ============================================

/**
 * Get a random design system
 */
export function random(): CompleteDesignSystem | null {
  const all = getAllDesignSystems();
  if (all.length === 0) return null;

  const randomIndex = Math.floor(Math.random() * all.length);
  return getComplete(all[randomIndex].id);
}

/**
 * Get featured/recommended design systems
 */
export function featured(): CompleteDesignSystem[] {
  const featuredNames = [
    'claude',
    'vercel',
    'notion',
    'neo-brutalism',
    'cosmic-night',
    'kodama-grove',
    'elegant-luxury',
    'cyberpunk',
  ];

  return featuredNames
    .map((name) => getComplete(name))
    .filter((s): s is CompleteDesignSystem => s !== null);
}

/**
 * Get all available styles
 */
export function listStyles(): DesignStyle[] {
  return [
    'minimal',
    'bold',
    'playful',
    'elegant',
    'tech',
    'retro',
    'nature',
    'corporate',
  ];
}

/**
 * Get all available moods
 */
export function listMoods(): DesignMood[] {
  return [
    'professional',
    'creative',
    'tech',
    'warm',
    'cool',
    'dramatic',
    'calm',
    'energetic',
  ];
}
