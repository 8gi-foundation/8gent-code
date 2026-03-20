#!/usr/bin/env bun
/**
 * Generate 4 variations of the 8gent.world landing page using eight:latest
 * at different creativity temperatures (0.25, 0.5, 0.75, 1.0).
 *
 * Falls back to devstral:latest if eight:latest times out.
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const OLLAMA_URL = "http://localhost:11434/api/generate";
const PRIMARY_MODEL = "eight:latest";
const FALLBACK_MODEL = "devstral:latest";
const TIMEOUT_MS = 600_000; // 10 minutes

const WORLD_DIR = join(import.meta.dir, "../../8gent-world");
const VARIATIONS_DIR = join(WORLD_DIR, "src/app/variations");

const TEMPERATURES = [
  { temp: 0.25, label: "conservative", dir: "v1" },
  { temp: 0.5, label: "balanced", dir: "v2" },
  { temp: 0.75, label: "creative", dir: "v3" },
  { temp: 1.0, label: "experimental", dir: "v4" },
];

const PROMPT = `You are a world-class React developer building a Next.js landing page.

DESIGN SYSTEM: Industrial minimal inspired by hardware product design.
- Typography: Monospace font stack ('SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace). All caps for labels. Tight letter-spacing.
- Colors: Off-white background (#e6e5e0). Black text (#2b2b2b). Orange accent (#e85d04). NEVER use purple, violet, magenta, or pink.
- Layout: Grid-based. Generous whitespace. Sharp borders (border-radius: 0 for buttons and inputs). 1px borders.
- Aesthetic: Like a product spec sheet that became a website. Technical but beautiful.

ANIMATION PATTERNS (use Framer Motion):
- fadeInUp: initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }}
- staggerChildren: parent variants with staggerChildren: 0.08
- splitTextReveal: each word animates independently with delay
- parallax: useScroll + useTransform for scroll-linked motion
- counterUp: animated number counting with requestAnimationFrame
- buttonPress: whileTap={{ scale: 0.97 }}
- hoverLift: whileHover={{ y: -4 }}

PAGE CONTENT (8gent Code landing page):
1. Nav: logo "8gent.", links: Code, Benchmarks, Docs, GitHub
2. Hero: "Local coding agent. Verified changes. $0 by default." with subtext about running on your machine with local models
3. Proof strip: 4 badges (execution-graded benchmarks, evidence + tests, local models, open source)
4. How it works: 3 steps (connect repo, ask for change, get plan + diffs + tests)
5. Why 8gent: 4 feature cards (stop paying for tokens, keep code private, fewer broken changes, use any model)
6. Personalization: adapts to you section (onboarding, cloud sync, session resume, personal training, ESC to interrupt)
7. Sovereignty: your agent gets smarter - three layer model (base, eight LoRA, personal LoRA)
8. Benchmarks highlight: execution-graded, reproducible
9. Pricing: Free ($0 forever) vs Pro (coming soon)
10. Final CTA: "Ready to code without limits?" with install command
11. Footer: links, MIT license, copyright

OUTPUT: A single React component ("use client") that is a complete Next.js page.tsx file. Use Framer Motion for animations. Use Tailwind CSS classes. Include all content inline (no imports except react, framer-motion). Make it responsive (mobile-first). No external images - use CSS shapes and gradients for visual elements. No purple/pink colors ever. No em dashes ever.

Be creative with the layout and animation choreography. Make the scroll experience feel premium.`;

function extractComponent(raw: string): string {
  // Strip markdown code fences if present
  let code = raw;

  // Remove ```tsx or ```typescript or ```jsx or ``` fences
  code = code.replace(/^```(?:tsx|typescript|jsx|js)?\s*\n/gm, "");
  code = code.replace(/\n```\s*$/gm, "");
  code = code.replace(/^```\s*$/gm, "");

  // Find the start of actual React code
  const markers = ['"use client"', "'use client'", "export default"];
  let startIdx = -1;
  for (const marker of markers) {
    const idx = code.indexOf(marker);
    if (idx !== -1 && (startIdx === -1 || idx < startIdx)) {
      startIdx = idx;
    }
  }

  if (startIdx > 0) {
    // Include any imports that come before - scan back for import statements
    const before = code.substring(0, startIdx);
    const lines = before.split("\n");
    let importStart = startIdx;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith("import ") || line.startsWith("'use client'") || line.startsWith('"use client"') || line === "") {
        importStart = before.indexOf(lines[i]);
        if (importStart === -1) importStart = startIdx;
      } else if (line.length > 0) {
        break;
      }
    }
    code = code.substring(Math.min(importStart, startIdx));
  }

  // Ensure it starts with "use client" if not present
  if (!code.includes('"use client"') && !code.includes("'use client'")) {
    code = '"use client";\n\n' + code;
  }

  return code.trim() + "\n";
}

async function callOllama(
  model: string,
  temperature: number,
  signal: AbortSignal
): Promise<string> {
  console.log(`  [ollama] Calling ${model} at temperature ${temperature}...`);
  const start = Date.now();

  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: PROMPT,
      stream: false,
      options: {
        temperature,
        num_predict: 16384,
      },
    }),
    signal,
  });

  if (!res.ok) {
    throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as { response: string };
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`  [ollama] ${model} responded in ${elapsed}s (${data.response.length} chars)`);
  return data.response;
}

async function generateVariation(
  temp: number,
  label: string,
  dir: string
): Promise<{ model: string; elapsed: number }> {
  const outDir = join(VARIATIONS_DIR, dir);
  mkdirSync(outDir, { recursive: true });

  let model = PRIMARY_MODEL;
  let raw: string;
  const start = Date.now();

  try {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    raw = await callOllama(PRIMARY_MODEL, temp, signal);
  } catch (err: any) {
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      console.log(`  [fallback] ${PRIMARY_MODEL} timed out, trying ${FALLBACK_MODEL}...`);
      model = FALLBACK_MODEL;
      const signal = AbortSignal.timeout(TIMEOUT_MS);
      raw = await callOllama(FALLBACK_MODEL, temp, signal);
    } else {
      throw err;
    }
  }

  const component = extractComponent(raw);
  const outPath = join(outDir, "page.tsx");
  writeFileSync(outPath, component);

  const elapsed = (Date.now() - start) / 1000;
  console.log(`  [saved] ${outPath} (${label}, model: ${model}, ${elapsed.toFixed(1)}s)`);
  return { model, elapsed };
}

// ── Index page for browsing variations ──────────────────────────────

function createIndexPage() {
  const indexPath = join(VARIATIONS_DIR, "page.tsx");
  const content = `"use client";

import Link from "next/link";

const variations = [
  { path: "/variations/v1", temp: "0.25", label: "Conservative", desc: "Low temperature - predictable, clean layout" },
  { path: "/variations/v2", temp: "0.50", label: "Balanced", desc: "Medium temperature - good mix of structure and creativity" },
  { path: "/variations/v3", temp: "0.75", label: "Creative", desc: "Higher temperature - more unique design choices" },
  { path: "/variations/v4", temp: "1.00", label: "Experimental", desc: "Max temperature - wild, unexpected layouts" },
];

export default function VariationsIndex() {
  return (
    <div style={{
      minHeight: "100vh",
      background: "#e6e5e0",
      color: "#2b2b2b",
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
      padding: "80px 24px",
    }}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <h1 style={{
          fontSize: "clamp(28px, 5vw, 48px)",
          fontWeight: 700,
          letterSpacing: "-0.02em",
          marginBottom: 8,
        }}>
          LANDING PAGE VARIATIONS
        </h1>
        <p style={{ fontSize: 14, color: "#666", marginBottom: 48, lineHeight: 1.6 }}>
          4 variations generated by eight:latest at different creativity temperatures.
          <br />
          Compare layouts, animation choices, and design decisions.
        </p>
        <div style={{ display: "grid", gap: 16 }}>
          {variations.map((v) => (
            <Link
              key={v.path}
              href={v.path}
              style={{
                display: "block",
                padding: "24px",
                border: "1px solid #2b2b2b",
                background: "#fff",
                textDecoration: "none",
                color: "#2b2b2b",
                transition: "transform 0.15s, box-shadow 0.15s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.transform = "translateY(-2px)";
                (e.currentTarget as HTMLElement).style.boxShadow = "0 4px 12px rgba(0,0,0,0.1)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.transform = "translateY(0)";
                (e.currentTarget as HTMLElement).style.boxShadow = "none";
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                <span style={{ fontSize: 18, fontWeight: 700, textTransform: "uppercase" as const }}>
                  {v.label}
                </span>
                <span style={{
                  fontSize: 11,
                  padding: "2px 8px",
                  border: "1px solid #e85d04",
                  color: "#e85d04",
                  fontWeight: 600,
                }}>
                  TEMP {v.temp}
                </span>
              </div>
              <p style={{ fontSize: 13, color: "#666", margin: 0 }}>{v.desc}</p>
            </Link>
          ))}
        </div>
        <p style={{ fontSize: 11, color: "#999", marginTop: 32 }}>
          Generated with eight:latest via Ollama
        </p>
      </div>
    </div>
  );
}
`;
  writeFileSync(indexPath, content);
  console.log(`[saved] Index page: ${indexPath}`);
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("=== 8gent Landing Page Variation Generator ===");
  console.log(`Models: ${PRIMARY_MODEL} (primary), ${FALLBACK_MODEL} (fallback)`);
  console.log(`Timeout: ${TIMEOUT_MS / 1000}s per call`);
  console.log(`Output: ${VARIATIONS_DIR}\n`);

  mkdirSync(VARIATIONS_DIR, { recursive: true });

  const results: Array<{ dir: string; label: string; temp: number; model: string; elapsed: number }> = [];

  for (const { temp, label, dir } of TEMPERATURES) {
    console.log(`\n--- Generating ${dir} (${label}, temp=${temp}) ---`);
    try {
      const { model, elapsed } = await generateVariation(temp, label, dir);
      results.push({ dir, label, temp, model, elapsed });
    } catch (err: any) {
      console.error(`  [ERROR] Failed to generate ${dir}: ${err.message}`);
    }
  }

  // Create index page
  createIndexPage();

  // Summary
  console.log("\n=== Generation Summary ===");
  for (const r of results) {
    console.log(`  ${r.dir} (${r.label}): temp=${r.temp}, model=${r.model}, ${r.elapsed.toFixed(1)}s`);
  }
  console.log(`\nGenerated ${results.length}/4 variations.`);
  if (results.length > 0) {
    console.log("Open http://localhost:3000/variations to browse them.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
