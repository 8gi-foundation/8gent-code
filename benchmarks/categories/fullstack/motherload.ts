import type { BenchmarkDefinition } from "../../types";

export const motherloadBenchmark: BenchmarkDefinition[] = [
	{
		id: "FS-MEGA-001",
		category: "fullstack",
		title:
			"SQLite Design System — Token Engine + Component Registry + Theme + Renderer",
		difficulty: "hard",
		prompt: `Build a complete SQLite-backed design system that an AI agent (8gent) can use to generate perfect UI. This is a FULL production system: design tokens, component registry, theme engine, and HTML renderer.

## Existing System (provided — DO NOT reimplement)

### design-db.ts (already in your working directory)
\`\`\`typescript
import { Database as BunDB } from "bun:sqlite";

// DesignDB wraps bun:sqlite with typed helpers:
// db.exec(sql)                     — run raw SQL
// db.query<T>(sql, params?): T[]   — query returning rows
// db.queryOne<T>(sql, params?): T  — query returning one row
// db.insert(sql, params?): number  — insert, returns lastInsertRowid
// db.mutate(sql, params?): number  — UPDATE/DELETE, returns changes count
// db.tableExists(name): boolean
// db.close()
//
// Types available: DesignTokenRow, ComponentRow, VariantRow, ThemeRow, ThemeTokenRow
\`\`\`

## Your Task — Create 6 Files

### 1. schema.ts — Database Schema & Migrations
Create all tables. Export \`runMigrations(db: DesignDB)\`.

Tables required:
- \`design_tokens\`: id INTEGER PK, category TEXT, name TEXT, value TEXT, description TEXT, is_reference INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT. UNIQUE(category, name).
- \`components\`: id INTEGER PK, name TEXT UNIQUE, category TEXT, description TEXT, props_schema TEXT (JSON), default_styles TEXT (JSON), created_at TEXT, updated_at TEXT.
- \`component_variants\`: id INTEGER PK, component_id INTEGER FK→components, name TEXT, styles TEXT (JSON), description TEXT. UNIQUE(component_id, name).
- \`themes\`: id INTEGER PK, name TEXT UNIQUE, base_theme_id INTEGER FK→themes (nullable, for inheritance), description TEXT, created_at TEXT.
- \`theme_tokens\`: id INTEGER PK, theme_id INTEGER FK→themes, token_id INTEGER FK→design_tokens, override_value TEXT. UNIQUE(theme_id, token_id).

### 2. tokens.ts — Design Token CRUD + Reference Resolution
Export a \`TokenEngine\` class:
- \`constructor(db: DesignDB)\`
- \`create(category, name, value, opts?)\` — Insert token, return row. Detect if value starts with "$" to set is_reference=1.
- \`get(category, name)\` — Get a single token
- \`list(category?)\` — List tokens, optionally filtered by category
- \`update(category, name, newValue)\` — Update a token's value
- \`delete(category, name)\` — Delete a token
- \`resolve(category, name, themeId?)\` — **CRITICAL**: Resolve token value. If is_reference=1, follow the reference chain (e.g., \`$color.primary\` → look up token category="color", name="primary"). If themeId provided, check theme_tokens for overrides first. Must handle chains up to 5 levels deep. Throw on circular references.

### 3. components.ts — Component Registry
Export a \`ComponentRegistry\` class:
- \`constructor(db: DesignDB)\`
- \`register(name, category, propsSchema, defaultStyles, description?)\` — Insert component
- \`get(name)\` — Get component by name, including all its variants
- \`list(category?)\` — List components
- \`addVariant(componentName, variantName, styles, description?)\` — Add a variant
- \`getVariant(componentName, variantName)\` — Get specific variant
- \`delete(name)\` — Delete component and all its variants

### 4. themes.ts — Theme Engine
Export a \`ThemeEngine\` class:
- \`constructor(db: DesignDB, tokenEngine: TokenEngine)\`
- \`create(name, description?, baseThemeName?)\` — Create theme, optionally inheriting from base
- \`get(name)\` — Get theme with all its token overrides
- \`setOverride(themeName, tokenCategory, tokenName, value)\` — Override a token's value in this theme
- \`resolveToken(themeName, tokenCategory, tokenName)\` — Resolve a token in theme context. Check: theme overrides → base theme overrides (walk inheritance) → default token value.
- \`list()\` — List all themes

### 5. renderer.ts — Component Renderer
Export a \`Renderer\` class:
- \`constructor(db: DesignDB, tokenEngine: TokenEngine, componentRegistry: ComponentRegistry, themeEngine: ThemeEngine)\`
- \`render(componentName, props, opts?)\` — Returns an HTML string. Steps:
  1. Look up component definition and its default_styles
  2. If \`props.variant\`, merge variant styles over defaults
  3. Resolve all token references in styles (e.g., \`"$color.primary"\` → \`"#3B82F6"\`)
  4. If \`opts.theme\`, resolve tokens using that theme
  5. Generate HTML: \`<div class="ds-{componentName}" style="{resolved styles}" data-variant="{variant}">{children}</div>\`
  6. Validate props against propsSchema — warn on missing required props
- \`renderToCSS(componentName, themeName?)\` — Returns CSS class definition for the component with resolved token values

### 6. system.ts — Entry Point
Export \`createDesignSystem(dbPath?)\` function:
- Creates DesignDB (default ":memory:")
- Runs migrations
- Instantiates TokenEngine, ComponentRegistry, ThemeEngine, Renderer
- Returns \`{ db, tokens, components, themes, renderer, seed }\`
- \`seed()\` method that populates a starter design system:
  - Colors: primary (#3B82F6), secondary (#8B5CF6), success (#22C55E), warning (#F59E0B), error (#EF4444), background (#FFFFFF), foreground (#0F172A)
  - Spacing: xs (4px), sm (8px), md (16px), lg (24px), xl (32px)
  - Typography: heading-1 (JSON: {fontSize:"32px",fontWeight:"700",lineHeight:"1.2"}), body (JSON: {fontSize:"16px",fontWeight:"400",lineHeight:"1.5"})
  - Radius: sm (4px), md (8px), lg (16px), full (9999px)
  - A "Button" component with variants: primary, secondary, outline, ghost
  - A "Card" component with default padding and border
  - A "light" theme (uses defaults) and a "dark" theme (overrides background→#0F172A, foreground→#F8FAFC)

## Output Format

\`\`\`typescript // schema.ts
// your schema code
\`\`\`

\`\`\`typescript // tokens.ts
// your token engine
\`\`\`

\`\`\`typescript // components.ts
// your component registry
\`\`\`

\`\`\`typescript // themes.ts
// your theme engine
\`\`\`

\`\`\`typescript // renderer.ts
// your renderer
\`\`\`

\`\`\`typescript // system.ts
// your entry point
\`\`\``,
		keywords: [
			// Schema
			"design_tokens",
			"components",
			"component_variants",
			"themes",
			"theme_tokens",
			"CREATE TABLE",
			"FOREIGN KEY",
			"UNIQUE",
			"runMigrations",
			// Tokens
			"TokenEngine",
			"resolve",
			"is_reference",
			"circular",
			"create",
			"get",
			"list",
			"update",
			"delete",
			// Components
			"ComponentRegistry",
			"register",
			"addVariant",
			"getVariant",
			"props_schema",
			"default_styles",
			// Themes
			"ThemeEngine",
			"setOverride",
			"resolveToken",
			"base_theme",
			"inheritance",
			"override",
			// Renderer
			"Renderer",
			"render",
			"renderToCSS",
			"style",
			// System
			"createDesignSystem",
			"seed",
			"#3B82F6",
			"#0F172A",
			"Button",
			"Card",
			"primary",
			"secondary",
			"outline",
			"ghost",
			"light",
			"dark",
		],
		keywordThreshold: 20,
		testExecution: true,
		testFile: "autoresearch/tests/FS-MEGA-001-design-system.test.ts",
		timeoutMs: 30000,
		multiFile: true,
		fixtures: ["fixtures/design-db.ts"],
	},
];
