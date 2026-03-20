#!/usr/bin/env bun
/**
 * Generate a Teenage Engineering-inspired landing page for 8gent One
 * using the eight:latest model, then open it in browser.
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const OLLAMA_URL = "http://localhost:11434/api/chat";
const MODEL = process.env.MODEL || "qwen3.5:latest";
const OUTPUT = join(import.meta.dir, "../benchmarks/ui-samples/8gent-one-landing.html");

mkdirSync(join(import.meta.dir, "../benchmarks/ui-samples"), { recursive: true });

const prompt = `You are a world-class frontend developer specializing in hardware product landing pages.

DESIGN SYSTEM: Teenage Engineering
- Typography: Monospace primary (Space Mono, IBM Plex Mono, or system monospace). All caps for labels. Tight letter-spacing.
- Colors: Off-white background (#f5f5f0 or #fafaf5). Black text (#1a1a1a). Orange accent (#ff6600 or #e85d04). No purple, violet, magenta, or pink ever.
- Layout: Grid-based. Generous whitespace. Asymmetric but balanced. Content blocks with sharp borders.
- Components: Flat buttons with sharp corners (border-radius: 0). Thin 1px borders. Outlined badges. Pill-shaped tags with monospace text.
- Aesthetic: Industrial minimal. Like a product spec sheet that became a website. Technical but beautiful. Hardware manuals meet web design.
- Imagery: Use CSS shapes and gradients for device mockup (no images needed). Geometric forms.
- Animation: Subtle. Fade-in on scroll. No bounce, no spring. Smooth opacity transitions only.

PRODUCT: 8gent One
- A handheld AI assistant device
- Runs local AI models (no cloud required)
- Voice-first interaction with physical buttons
- E-ink display for always-on status
- USB-C charging, all-day battery
- Open-source software, hackable hardware
- Price: TBD (waitlist)

PAGE STRUCTURE:
1. Nav bar - logo "8gent" (monospace), minimal links: Specs, Software, Waitlist
2. Hero - Large product name "ONE" with a CSS-drawn device outline (rectangle with rounded corners, screen area, 3 circular buttons). Tagline: "Your AI. In your hand. On your terms."
3. Specs grid - 6 spec cards in a 3x2 grid: Processor (NPU), Display (E-ink), Battery (all-day), Connectivity (WiFi/BT), Storage (local models), OS (open source)
4. Philosophy section - "No cloud. No subscription. No limits." with 3 short paragraphs about sovereignty, privacy, and ownership
5. Software section - "Runs 8gent Code" with terminal-style code block showing interaction
6. Waitlist CTA - Email input + "Join Waitlist" button. Clean, minimal form.
7. Footer - copyright, links, "Designed in San Francisco"

TECHNICAL REQUIREMENTS:
- Single HTML file with embedded CSS and minimal JS (scroll animations only)
- Fully responsive (mobile-first, looks great on phone)
- No external dependencies (no CDN links)
- Use CSS Grid and Flexbox
- System monospace font stack: 'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace
- No purple, violet, magenta, or pink colors anywhere
- No em dashes anywhere
- Smooth scroll behavior
- Viewport meta tag for mobile

Output ONLY the complete HTML. No markdown fences. No explanations. Start with <!DOCTYPE html>.`;

console.log("Generating 8gent One landing page with eight:latest...");
console.log("This may take 3-5 minutes.\n");

const start = Date.now();
const res = await fetch(OLLAMA_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: MODEL,
    messages: [
      { role: "system", content: "You are a frontend developer. Output ONLY complete HTML. No explanations. No markdown. Start with <!DOCTYPE html>." },
      { role: "user", content: prompt },
    ],
    stream: false,
    options: { num_predict: 16384, temperature: 0.4 },
  }),
  signal: AbortSignal.timeout(600_000), // 10 minute timeout
});

if (!res.ok) {
  console.error(`Ollama error: ${res.status}`);
  process.exit(1);
}

const data = await res.json() as any;
let html = data.message?.content || "";

// Clean up if wrapped in markdown
const fenced = html.match(/```html\s*([\s\S]*?)```/);
if (fenced) html = fenced[1];
const doctype = html.match(/(<!DOCTYPE[\s\S]*)/i);
if (doctype) html = doctype[1];

const duration = ((Date.now() - start) / 1000).toFixed(1);
console.log(`Generated in ${duration}s (${html.length} chars)`);

writeFileSync(OUTPUT, html.trim());
console.log(`Saved to: ${OUTPUT}`);

// Open in browser
const { execSync } = await import("child_process");
execSync(`open "${OUTPUT}"`);
console.log("Opened in browser.");
