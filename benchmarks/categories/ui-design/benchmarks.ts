import type { BenchmarkDefinition } from "../../types";

export const uiDesignBenchmarks: BenchmarkDefinition[] = [
  {
    id: "UI001",
    category: "ui-design",
    title: "Neumorphic Button Set — Soft Shadows, Pressed States, Disabled",
    difficulty: "medium",
    prompt: `Generate a complete HTML page with a set of 4 neumorphic buttons: primary, secondary, pressed/active, and disabled.

Requirements:
1. Background must be a light neutral color (#e0e5ec or similar)
2. Each button must use DUAL box-shadow (one light shadow, one dark shadow) to create the raised soft-shadow neumorphic effect
3. The pressed/active state must use INSET box-shadows (reversed depth)
4. Disabled button should have reduced opacity or contrast
5. Include hover transitions (smooth 300ms+)
6. border-radius >= 12px on all buttons
7. Use clean, modern sans-serif font

Output a SINGLE complete HTML file with embedded CSS in a <style> tag. No external dependencies.`,
    keywords: ["box-shadow", "inset", "border-radius", "transition", "hover", "disabled", "rgba", "background-color", "active", "opacity"],
    keywordThreshold: 6,
    testExecution: true,
    testFile: "autoresearch/tests/UI001-neumorphic.test.ts",
    timeoutMs: 10000,
  },
  {
    id: "UI002",
    category: "ui-design",
    title: "Glassmorphism Card Layout — Frosted Glass with Backdrop Blur",
    difficulty: "hard",
    prompt: `Generate a complete HTML page showing 3 frosted-glass cards overlapping on a colorful gradient background.

Requirements:
1. Background must be a vibrant multi-color gradient with colorful shapes/blobs behind the cards
2. Each card must use backdrop-filter: blur() with blur radius >= 10px
3. Cards must have semi-transparent backgrounds (rgba with alpha < 0.5)
4. Cards must have a subtle light border (1px solid rgba white with low alpha) for the glass edge
5. Cards should overlap using negative margins or absolute positioning so blur is visible over content
6. Each card contains: title, description text, and a small icon or emoji
7. border-radius >= 12px on cards
8. Use z-index for proper layering

Output a SINGLE complete HTML file with embedded CSS in a <style> tag. No external dependencies.`,
    keywords: ["backdrop-filter", "blur", "rgba", "gradient", "border", "border-radius", "opacity", "linear-gradient", "position", "z-index", "transparent"],
    keywordThreshold: 7,
    testExecution: true,
    testFile: "autoresearch/tests/UI002-glassmorphism.test.ts",
    timeoutMs: 10000,
  },
  {
    id: "UI003",
    category: "ui-design",
    title: "3D Isometric Dashboard — CSS Transform Perspective Grid",
    difficulty: "hard",
    prompt: `Generate a complete HTML page showing an isometric grid of 6 dashboard stat tiles using CSS 3D transforms.

Requirements:
1. Apply perspective on the container (at least 800px)
2. Each tile must use transform: rotateX() rotateY() to create an isometric viewing angle
3. Tiles should have visible depth using translateZ or pseudo-elements for side faces
4. Use transform-style: preserve-3d on the container
5. Each tile contains: a metric label, a large number value, and a small CSS bar chart (div bars with varying heights)
6. Tiles should have different accent colors
7. Hover effect: tile lifts (increases translateZ) with smooth transition
8. Clean dark or light theme

Output a SINGLE complete HTML file with embedded CSS in a <style> tag. No external dependencies.`,
    keywords: ["transform", "perspective", "rotateX", "rotateY", "translateZ", "transform-style", "preserve-3d", "transition", "hover", "grid", "box-shadow"],
    keywordThreshold: 7,
    testExecution: true,
    testFile: "autoresearch/tests/UI003-isometric.test.ts",
    timeoutMs: 10000,
  },
  {
    id: "UI004",
    category: "ui-design",
    title: "CSS Animation Showcase — Keyframes, Staggered Timing, Easing",
    difficulty: "medium",
    prompt: `Generate a complete HTML page demonstrating 5 distinct CSS animations:

1. A loading SPINNER using @keyframes with transform: rotate(360deg)
2. A PULSING dot/circle using scale() and opacity changes
3. A TYPING INDICATOR (3 bouncing dots with staggered animation-delay)
4. A SLIDE-IN card that animates from off-screen using translateX
5. A COLOR-CYCLING background using @keyframes with multiple color stops

Requirements:
- All animations must use @keyframes (5 distinct named keyframes)
- Include at least one cubic-bezier() custom easing
- Typing dots must have 3 different animation-delay values for stagger
- At least 2 animations must loop infinitely
- Use animation shorthand or longhand properties properly
- Clean layout with each animation in its own section with a label

Output a SINGLE complete HTML file with embedded CSS in a <style> tag. No external dependencies.`,
    keywords: ["@keyframes", "animation", "animation-delay", "cubic-bezier", "transform", "rotate", "scale", "translateX", "opacity", "infinite", "ease"],
    keywordThreshold: 7,
    testExecution: true,
    testFile: "autoresearch/tests/UI004-animations.test.ts",
    timeoutMs: 10000,
  },
  {
    id: "UI005",
    category: "ui-design",
    title: "Skeuomorphic Controls — Realistic Toggle Switch and Rotary Knob",
    difficulty: "hard",
    prompt: `Generate a complete HTML page with two skeuomorphic UI controls:

1. TOGGLE SWITCH:
   - Metallic track with layered gradients and inset shadows
   - Circular knob with radial-gradient simulating a 3D sphere
   - Smooth sliding transition when toggled
   - Light reflection spot on the knob (small white gradient)
   - Use checkbox hack for state (input:checked + label, NO JavaScript)

2. ROTARY KNOB/DIAL:
   - Circular shape with radial-gradient for 3D depth
   - Notch indicator line using ::before or ::after pseudo-element
   - Concentric ring effects using multiple box-shadow layers (3+)
   - Brushed-metal texture using repeating-linear-gradient

Requirements:
- NO JavaScript — pure CSS interactions only
- Use :checked selector for toggle state
- border-radius: 50% for circular elements
- Multiple layered gradients for realistic depth

Output a SINGLE complete HTML file with embedded CSS in a <style> tag. No external dependencies.`,
    keywords: ["radial-gradient", "linear-gradient", "box-shadow", "inset", "border-radius", "50%", "transform", "rotate", "transition", "::before", "::after", "checked", "repeating-linear-gradient"],
    keywordThreshold: 8,
    testExecution: true,
    testFile: "autoresearch/tests/UI005-skeuomorphic.test.ts",
    timeoutMs: 10000,
  },
  {
    id: "UI006",
    category: "ui-design",
    title: "Dark Theme Analytics Dashboard — WCAG Contrast, Charts, Sidebar",
    difficulty: "medium",
    prompt: `Generate a complete HTML page for a dark-theme analytics dashboard.

Requirements:
1. Dark background (#0f0f0f to #1a1a2e range)
2. Sidebar navigation with icon placeholders (emoji or unicode) and active state
3. Header with title and user avatar circle
4. 4 stat cards in a row: metric label (muted text), large number (bright text), percentage change with green (positive) / red (negative) color coding
5. CSS-only bar chart with 7 bars of varying heights, with axis labels
6. All text must meet WCAG AA contrast (text no darker than #a0a0a0 on dark backgrounds)
7. Use CSS custom properties (--variables) for the color palette (at least 4 custom properties)
8. Use var() to reference custom properties throughout
9. Use flexbox or grid for layout

Output a SINGLE complete HTML file with embedded CSS in a <style> tag. No external dependencies.`,
    keywords: ["--", "var(", "background-color", "color", "border-radius", "grid", "flex", "box-shadow", "rgba", "hover", "sidebar"],
    keywordThreshold: 7,
    testExecution: true,
    testFile: "autoresearch/tests/UI006-dark-dashboard.test.ts",
    timeoutMs: 10000,
  },
  {
    id: "UI007",
    category: "ui-design",
    title: "Responsive Magazine Layout — CSS Grid Areas, Breakpoints",
    difficulty: "hard",
    prompt: `Generate a complete HTML page with a magazine-style layout adapting to 3 breakpoints.

Requirements:
1. DESKTOP (>1024px): 3-column CSS grid with hero article spanning 2 columns and 2 rows, sidebar, and 4 smaller article cards. Use grid-template-areas with named areas.
2. TABLET (768-1024px): 2-column grid, hero spans full width single row, articles reflow
3. MOBILE (<768px): single column, all items stack
4. Hero article: large placeholder image area (colored div with aspect-ratio), overlaid title at bottom with gradient overlay (transparent to opaque)
5. Each article card: image placeholder, category tag, title, excerpt truncated to 2 lines with -webkit-line-clamp
6. Use @media queries for breakpoints
7. Use gap for spacing, 1fr and minmax() in grid definitions
8. At least 5 article/card elements total

Output a SINGLE complete HTML file with embedded CSS in a <style> tag. No external dependencies.`,
    keywords: ["grid-template-areas", "grid-area", "@media", "grid-template-columns", "aspect-ratio", "-webkit-line-clamp", "gap", "minmax", "1fr", "position", "gradient"],
    keywordThreshold: 7,
    testExecution: true,
    testFile: "autoresearch/tests/UI007-responsive-grid.test.ts",
    timeoutMs: 10000,
  },
  {
    id: "UI008",
    category: "ui-design",
    title: "Interactive Pricing Cards — 3D Tilt, Hover Glow, Feature List",
    difficulty: "hard",
    prompt: `Generate a complete HTML page with 3 pricing cards (Basic, Pro, Enterprise).

Requirements:
1. Cards arranged in a row. Pro card is "featured" — slightly larger/elevated with a "Most Popular" badge
2. Each card has: plan name, price with large number and /month suffix, 6+ feature items with check/cross icons (unicode ✓ ✗ or CSS), CTA button
3. CSS-only 3D tilt effect on hover: use perspective on container, transform: rotateX() rotateY() changes on hover
4. Hover glow: colored box-shadow glow effect (large spread, colored shadow) on hover
5. Featured card has a gradient border (use border-image or pseudo-element with gradient behind solid-bg inner)
6. Button hover: background-color transition + slight scale transform
7. Smooth transitions on all interactive states (300ms+)
8. Clean modern design with good typography

Output a SINGLE complete HTML file with embedded CSS in a <style> tag. No external dependencies.`,
    keywords: ["perspective", "transform", "rotateX", "rotateY", "box-shadow", "transition", "hover", "scale", "linear-gradient", "position", "z-index", "::before"],
    keywordThreshold: 7,
    testExecution: true,
    testFile: "autoresearch/tests/UI008-pricing-cards.test.ts",
    timeoutMs: 10000,
  },
];
