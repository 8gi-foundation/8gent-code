/**
 * Design Systems Database for 8gent
 *
 * SQLite-backed design system registry extracted from James Spalding's portfolio.
 * Provides query functions for finding and suggesting design systems based on
 * style, mood, project type, and tags.
 *
 * @example
 * ```ts
 * import { initDatabase, suggestForProject, findByStyle, getComplete } from '@8gent/design-systems';
 *
 * // Initialize database (run once on startup)
 * initDatabase();
 *
 * // Suggest design systems for an AI chatbot project
 * const suggestions = suggestForProject('ai');
 * console.log(suggestions[0].reasoning);
 *
 * // Find all minimal design systems
 * const minimal = findByStyle('minimal');
 *
 * // Get complete design system with all data
 * const claude = getComplete('claude');
 * console.log(claude?.parsedColors?.primary);
 * ```
 */

// Schema exports
export {
	SCHEMA,
	type DesignSystem,
	type ColorPalette,
	type Typography,
	type Component,
	type StyleTag,
	type DesignStyle,
	type DesignMood,
	type FontCategory,
	type ParsedColors,
	type ParsedTypography,
} from "./schema";

// Database operations
export {
	initDatabase,
	getDatabase,
	closeDatabase,
	insertDesignSystem,
	getDesignSystemById,
	getDesignSystemByName,
	getAllDesignSystems,
	getDesignSystemsByStyle,
	getDesignSystemsByMood,
	insertColorPalette,
	getColorPaletteBySystemId,
	insertTypography,
	getTypographyBySystemId,
	insertComponent,
	getComponentsBySystemId,
	getComponentByType,
	insertStyleTag,
	getTagsBySystemId,
	getSystemsByTag,
	searchDesignSystems,
	insertDesignSystemWithRelations,
	parseColorsJson,
	parseTypographyJson,
	hslToHex,
	getDatabaseStats,
} from "./db";

// Extracted themes from portfolio
export {
	EXTRACTED_THEMES,
	getAllThemes,
	getThemeByName,
	filterByStyle,
	filterByMood,
	searchByTag,
	hslToCss,
	type ExtractedTheme,
} from "./extractor";

// Query interface (main API)
export {
	// Core queries
	listAll,
	getComplete,
	findByStyle,
	findByMood,
	findByTag,
	search,
	// Suggestions
	suggestForProject,
	findSimilar,
	// CSS generation
	generateCssVariables,
	generateTailwindConfig,
	getHexPalette,
	// Quick access
	random,
	featured,
	listStyles,
	listMoods,
	// Types
	type CompleteDesignSystem,
	type DesignSuggestion,
} from "./query";

// Seeding function
export { seedDatabase } from "./seed";
