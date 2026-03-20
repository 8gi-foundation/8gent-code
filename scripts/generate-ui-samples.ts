#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const OLLAMA_URL = "http://localhost:11434/api/chat";
const MODEL = "eight:latest";
const OUTPUT_DIR = join(import.meta.dir, "../benchmarks/ui-samples");

mkdirSync(OUTPUT_DIR, { recursive: true });

const prompts: Record<string, string> = {
  "UI001-neumorphic-buttons": "Generate a complete HTML page with a set of 4 neumorphic buttons: primary, secondary, pressed/active, and disabled. Background must be a light neutral color (#e0e5ec or similar). Each button must use DUAL box-shadow (one light shadow, one dark shadow). The pressed/active state must use INSET box-shadows. Disabled button should have reduced opacity. Include hover transitions (smooth 300ms+). border-radius >= 12px. Use clean, modern sans-serif font. Output a SINGLE complete HTML file with embedded CSS in a <style> tag. No external dependencies.",
  "UI002-glassmorphism-cards": "Generate a complete HTML page showing 3 frosted-glass cards overlapping on a colorful gradient background. Background must be a vibrant multi-color gradient with colorful shapes/blobs behind the cards. Each card must use backdrop-filter: blur() with blur radius >= 10px. Cards must have semi-transparent backgrounds (rgba with alpha < 0.5). Cards must have a subtle light border. Cards should overlap. Each card contains: title, description text, and a small icon or emoji. border-radius >= 12px on cards. Output a SINGLE complete HTML file with embedded CSS in a <style> tag.",
  "UI003-isometric-dashboard": "Generate a complete HTML page showing an isometric grid of 6 dashboard stat tiles using CSS 3D transforms. Apply perspective on the container (at least 800px). Each tile must use transform: rotateX() rotateY() to create an isometric viewing angle. Each tile shows: icon/emoji, metric name, large number, and a small trend indicator. Use a dark background with colorful tile accents. Include hover effect that lifts the tile (translateZ). Smooth transitions on all interactions. Output a SINGLE complete HTML file with embedded CSS.",
  "UI004-css-animations": "Generate a complete HTML page demonstrating 5 distinct CSS animations: 1. A loading spinner (rotating circle/arc using @keyframes rotate). 2. A bouncing ball (translateY with ease-in-out timing). 3. A pulsing notification dot (scale + opacity keyframes). 4. A text typing effect (width animation on overflow:hidden element with steps()). 5. A card flip (rotateY 180deg on hover with backface-visibility:hidden). Each animation should be in its own section with a label. Use clean layout with flexbox/grid. Output a SINGLE complete HTML file.",
  "UI005-skeuomorphic-controls": "Generate a complete HTML page with two skeuomorphic UI controls: 1. A realistic toggle switch with smooth sliding animation, slight gradient on the track, drop shadow on the knob. Must use checkbox hack (input:checked + label). 2. A circular volume knob that can be rotated (use CSS custom properties and transforms, visual rotation only). Include subtle textures via CSS gradients (no images). Both controls should have labels. Warm, tactile aesthetic with shadows and gradients. Output a SINGLE complete HTML file.",
  "UI006-dark-analytics": "Generate a complete HTML page for a dark-theme analytics dashboard. Must include: 1. A sidebar navigation with icons (emoji) and active state. 2. A header with search input and user avatar. 3. A grid of 4 stat cards (revenue, users, orders, conversion) with large numbers and trend arrows. 4. A chart area (pure CSS bar chart with 7 bars, different heights, labeled). 5. A recent activity list (5 items with avatars, descriptions, timestamps). Dark background (#0f0f0f to #1a1a2e range). Accent color for highlights. Output a SINGLE complete HTML file.",
  "UI007-magazine-layout": "Generate a complete HTML page with a magazine-style layout adapting to 3 breakpoints. Desktop (1200px+): 3-column grid with featured hero spanning full width. Tablet (768-1199px): 2-column grid. Mobile (<768px): single column stack. Must include: hero image area (use CSS gradient as placeholder), article cards with title/excerpt/author/date, a sidebar with tags and newsletter signup form. Use @media queries for all 3 breakpoints. Typography: large serif headings, sans-serif body. Output a SINGLE complete HTML file.",
  "UI008-pricing-cards": "Generate a complete HTML page with 3 pricing cards (Basic, Pro, Enterprise). The Pro/middle card must be visually elevated (larger, border highlight, 'Most Popular' badge). Each card: plan name, price with /mo, feature list with checkmarks, CTA button. Hover effect: subtle lift with shadow increase. Use a clean light background. Cards in a centered flex/grid row. The CTA buttons should have distinct styles per tier (outline for Basic, filled for Pro, dark for Enterprise). Output a SINGLE complete HTML file.",
};

async function generate(id: string, prompt: string): Promise<string> {
  console.log(`Generating ${id}...`);
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: "You are an expert frontend developer. Output ONLY a complete HTML file. No explanations. No markdown fences. Just the HTML starting with <!DOCTYPE html>." },
        { role: "user", content: prompt },
      ],
      stream: false,
      options: { num_predict: 8192, temperature: 0.3 },
    }),
  });

  if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
  const data = await res.json() as any;
  let html = data.message?.content || "";

  // Extract HTML if wrapped in markdown fences
  const fenced = html.match(/```html\s*([\s\S]*?)```/);
  if (fenced) html = fenced[1];
  const doctype = html.match(/(<!DOCTYPE[\s\S]*)/i);
  if (doctype) html = doctype[1];

  return html.trim();
}

console.log("Generating all 8 UI benchmarks with eight:latest...\n");

const results: string[] = [];
for (const [id, prompt] of Object.entries(prompts)) {
  try {
    const html = await generate(id, prompt);
    const path = join(OUTPUT_DIR, `${id}.html`);
    writeFileSync(path, html);
    console.log(`  ✅ ${id} (${html.length} chars)\n`);
    results.push(path);
  } catch (err: any) {
    console.log(`  ❌ ${id}: ${err.message}\n`);
  }
}

console.log(`\nDone! ${results.length}/8 generated.`);
console.log(`Files in: ${OUTPUT_DIR}`);

// Open all in browser
for (const path of results) {
  const { execSync } = await import("child_process");
  execSync(`open "${path}"`);
}
