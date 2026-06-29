/**
 * scaffold.ts - the structure the harness GIVES weak local models up front so
 * "little instruction" works. Instead of asking a small model to architect a
 * project from zero, we hand it the config, layout, types, and design tokens,
 * then ask it to fill component/page gaps against a KNOWN shape.
 *
 * getScaffold(projectType) returns a Scaffold from pipeline-contracts.ts. It
 * never throws: unknown project types fall back to a generic scaffold.
 *
 * Brand rules baked into every scaffold (and enforced in file contents):
 *   - No purple/pink/violet (hues 270-350 banned).
 *   - No em dashes anywhere; use hyphens.
 *   - Dark background, bone text, electric-lime accent (#ccff00).
 */

import type { Scaffold, ScaffoldFile } from "./pipeline-contracts.js";

// ── Shared design tokens (dark theme, lime accent, zero purple/pink) ─────────

const NEXT_APP_TOKENS: Record<string, string> = {
	bg: "#0a0a0a",
	bgElevated: "#141414",
	text: "#f5f1e6",
	textMuted: "#a3a097",
	accent: "#ccff00",
	accentMuted: "#9fc000",
	border: "#262626",
	radius: "0.75rem",
	font: "ui-sans-serif, system-ui, sans-serif",
};

// ── next-app: Next.js 14 App Router + TypeScript + Tailwind v3 + framer ──────

function nextAppFiles(): ScaffoldFile[] {
	const packageJson = {
		name: "next-app",
		version: "0.1.0",
		private: true,
		scripts: {
			dev: "next dev",
			build: "next build",
			start: "next start",
			lint: "next lint",
		},
		dependencies: {
			next: "14.2.5",
			react: "18.3.1",
			"react-dom": "18.3.1",
			"framer-motion": "11.3.8",
		},
		devDependencies: {
			typescript: "5.5.4",
			"@types/node": "20.14.12",
			"@types/react": "18.3.3",
			"@types/react-dom": "18.3.0",
			tailwindcss: "3.4.7",
			postcss: "8.4.40",
			autoprefixer: "10.4.19",
		},
	};

	const nextConfig = `/** @type {import('next').NextConfig} */
const nextConfig = {
	reactStrictMode: true,
};

export default nextConfig;
`;

	const tsConfig = {
		compilerOptions: {
			target: "ES2020",
			lib: ["dom", "dom.iterable", "esnext"],
			allowJs: true,
			skipLibCheck: true,
			strict: true,
			noEmit: true,
			esModuleInterop: true,
			module: "esnext",
			moduleResolution: "bundler",
			resolveJsonModule: true,
			isolatedModules: true,
			jsx: "preserve",
			incremental: true,
			plugins: [{ name: "next" }],
			paths: {
				"@/*": ["./*"],
			},
		},
		include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
		exclude: ["node_modules"],
	};

	const postcssConfig = `/** @type {import('postcss-load-config').Config} */
const config = {
	plugins: {
		tailwindcss: {},
		autoprefixer: {},
	},
};

export default config;
`;

	const tailwindConfig = `import type { Config } from "tailwindcss";

const config: Config = {
	darkMode: "class",
	content: [
		"./app/**/*.{ts,tsx}",
		"./components/**/*.{ts,tsx}",
	],
	theme: {
		extend: {
			colors: {
				bg: "#0a0a0a",
				"bg-elevated": "#141414",
				text: "#f5f1e6",
				"text-muted": "#a3a097",
				accent: "#ccff00",
				"accent-muted": "#9fc000",
				border: "#262626",
			},
			borderRadius: {
				DEFAULT: "0.75rem",
			},
			fontFamily: {
				sans: ["ui-sans-serif", "system-ui", "sans-serif"],
			},
		},
	},
	plugins: [],
};

export default config;
`;

	const globalsCss = `@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
	color-scheme: dark;
}

html,
body {
	min-height: 100%;
}

body {
	background-color: #0a0a0a;
	color: #f5f1e6;
	font-family: ui-sans-serif, system-ui, sans-serif;
	-webkit-font-smoothing: antialiased;
}

::selection {
	background-color: #ccff00;
	color: #0a0a0a;
}

a {
	color: inherit;
	text-decoration: none;
}
`;

	const layoutTsx = `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
	title: "next-app",
	description: "Built on the 8gent scaffold: dark theme, lime accent.",
};

export default function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<html lang="en" className="dark">
			<body className="min-h-screen bg-bg text-text antialiased">
				{children}
			</body>
		</html>
	);
}
`;

	return [
		{ path: "package.json", content: JSON.stringify(packageJson, null, 2) + "\n" },
		{ path: "next.config.mjs", content: nextConfig },
		{ path: "tsconfig.json", content: JSON.stringify(tsConfig, null, 2) + "\n" },
		{ path: "postcss.config.mjs", content: postcssConfig },
		{ path: "tailwind.config.ts", content: tailwindConfig },
		{ path: "app/globals.css", content: globalsCss },
		{ path: "app/layout.tsx", content: layoutTsx },
	];
}

const NEXT_APP_STRUCTURE_NOTE = `PROJECT: Next.js 14 (App Router) + TypeScript + Tailwind v3 + framer-motion.

WHERE THINGS GO
- Pages live in app/. Each route is a folder with a page.tsx; the home page is app/page.tsx.
- Reusable components live in components/ and use the "use client" directive when they use hooks or animation.
- Import components via "@/components/..." (the "@/*" path alias points at the project root).
- Shared types live in types/ and import via "@/types/...".
- Global styles already exist in app/globals.css and are imported once in app/layout.tsx. Do not re-import them elsewhere.

STYLING
- Use Tailwind utility classes plus the theme tokens defined in tailwind.config.ts:
  bg, bg-elevated, text, text-muted, accent, accent-muted, border.
- The accent is electric lime (#ccff00) on a near-black (#0a0a0a) background with bone (#f5f1e6) text.
- Animations use framer-motion (import { motion } from "framer-motion").

BRAND RULES (HARD)
- NO purple, pink, or violet. Hues 270-350 are banned. Use the lime accent for emphasis.
- NO em dashes anywhere. Use hyphens.
- Dark background, bone text, lime accent. Keep contrast high and the layout calm.

WHAT TO BUILD
- You are filling gaps against this known shape. Build app/page.tsx and any components/*.tsx the page needs. The config, layout, and tokens are already provided.`;

// ── static-site: plain HTML + CSS shell ──────────────────────────────────────

function staticSiteFiles(): ScaffoldFile[] {
	const indexHtml = `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>static-site</title>
		<link rel="stylesheet" href="style.css" />
	</head>
	<body>
		<main id="app">
			<!-- Build the page content here. -->
		</main>
	</body>
</html>
`;

	const styleCss = `:root {
	--bg: #0a0a0a;
	--text: #f5f1e6;
	--text-muted: #a3a097;
	--accent: #ccff00;
	--border: #262626;
}

* {
	box-sizing: border-box;
}

html,
body {
	margin: 0;
	min-height: 100%;
}

body {
	background-color: var(--bg);
	color: var(--text);
	font-family: ui-sans-serif, system-ui, sans-serif;
	-webkit-font-smoothing: antialiased;
}

a {
	color: var(--accent);
}

::selection {
	background-color: var(--accent);
	color: var(--bg);
}
`;

	return [
		{ path: "index.html", content: indexHtml },
		{ path: "style.css", content: styleCss },
	];
}

const STATIC_SITE_STRUCTURE_NOTE = `PROJECT: Plain static site (HTML + CSS), no build step.

WHERE THINGS GO
- index.html is the single entry point. Add page content inside <main id="app">.
- style.css holds all styles. CSS custom properties (--bg, --text, --accent, --border) are already defined.

BRAND RULES (HARD)
- NO purple, pink, or violet. Hues 270-350 are banned.
- NO em dashes. Use hyphens.
- Dark background (#0a0a0a), bone text (#f5f1e6), electric-lime accent (#ccff00).

WHAT TO BUILD
- Fill index.html with the requested content and extend style.css. The shell and tokens are already provided.`;

// ── generic fallback: never throw on unknown project types ───────────────────

const GENERIC_STRUCTURE_NOTE = `PROJECT: generic (unknown type).

No boilerplate was generated because the project type is not recognized. Decide a
sensible structure for the requested project, keep files small and focused, and
follow these hard brand rules in everything you write:
- NO purple, pink, or violet. Hues 270-350 are banned.
- NO em dashes. Use hyphens.
- Prefer a dark background, bone text, and an electric-lime accent (#ccff00).`;

const GENERIC_TOKENS: Record<string, string> = {
	bg: "#0a0a0a",
	text: "#f5f1e6",
	accent: "#ccff00",
};

/**
 * Return the scaffold for a project type. Implemented fully for "next-app" and
 * "static-site"; any other value yields a generic, empty scaffold (never throws).
 */
export function getScaffold(projectType: string): Scaffold {
	switch (projectType) {
		case "next-app":
			return {
				projectType: "next-app",
				files: nextAppFiles(),
				structureNote: NEXT_APP_STRUCTURE_NOTE,
				designTokens: NEXT_APP_TOKENS,
			};
		case "static-site":
			return {
				projectType: "static-site",
				files: staticSiteFiles(),
				structureNote: STATIC_SITE_STRUCTURE_NOTE,
				designTokens: GENERIC_TOKENS,
			};
		default:
			return {
				projectType,
				files: [],
				structureNote: GENERIC_STRUCTURE_NOTE,
				designTokens: GENERIC_TOKENS,
			};
	}
}
