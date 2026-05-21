#!/usr/bin/env bun
/**
 * portfolio-arena.ts - end-to-end workflow run for the AutoResearch
 * head-to-head: the three local models build a deliverable as one system.
 *
 * Workflow (each role -> its strength, per ~/.8gent/roles.json):
 *   0. design lookup  query the design-system DB for real brand tokens
 *   1. orchestrator   plans the build
 *   2. engineer       writes the code from the plan + tokens
 *   3. qa             reviews the code, lists concrete defects
 *   4. engineer       applies the fixes
 *
 * Round 1 failed: qwen3.6:27b is a reasoning model; an uncapped build-plan
 * generation ran an unbounded thinking trace past Ollama's 5-minute load
 * window. Round 2 fixes this - models are warmed first, the reasoning trace
 * is disabled (think:false), and every generation is length-capped.
 *
 *   bun run benchmarks/autoresearch/portfolio-arena.ts
 *   ARENA_ROUND=round-3 bun run benchmarks/autoresearch/portfolio-arena.ts
 *
 * Output: benchmarks/autoresearch/arena/<round>/8gent/index.html + run.json
 */

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRoleConfig, type RoleModelAssignment } from "../../packages/orchestration/role-config";

const ROUND = process.env.ARENA_ROUND ?? "round-2";
const REPO_ROOT = join(import.meta.dir, "..", "..");
const OUT_DIR = join(import.meta.dir, "arena", ROUND, "8gent");
const DESIGN_DB = join(REPO_ROOT, "data", "design-systems.db");
const CALL_TIMEOUT_MS = 480_000; // 8 min hard ceiling per call.

const TASK = `Build a single-file animated 3D portfolio hero section as index.html.
Requirements:
- A full-viewport Three.js scene loaded from the unpkg CDN (three@0.160.0 ES module).
- An animated 3D centerpiece: a geometry that rotates continuously and reacts to mouse movement.
- Tasteful lighting (ambient + directional). Dark theme. No purple, pink, or violet hues.
- Overlaid HTML: a name headline "James Spalding", a one-line role subtitle, one call-to-action button.
- Responsive: the canvas resizes with the window; readable on mobile.
- requestAnimationFrame loop with proper cleanup. No build step, no npm. Pure HTML+JS+CSS in one file.
Output ONLY the complete contents of index.html, nothing else.`;

interface RoleResult {
	step: string;
	provider: string;
	model: string;
	ms: number;
	chars: number;
	ok: boolean;
	error?: string;
}

function log(msg: string): void {
	console.log(`[${new Date().toISOString()}] ${msg}`);
}

// --- design-system DB ---------------------------------------------------

/**
 * Pull a real design system from the inbuilt DB so the engineer builds from
 * brand tokens instead of inventing colours. Picks a dark-friendly minimal
 * system; returns a formatted token block for the prompt.
 */
function designTokens(): { system: string; block: string } {
	try {
		const db = new Database(DESIGN_DB, { readonly: true });
		// Prefer a minimal/professional system; fall back to any system.
		const sys = db
			.query(
				`SELECT id, name FROM design_systems
			 WHERE style IN ('minimal','elegant','tech') ORDER BY
			 CASE id WHEN 'linear' THEN 0 WHEN 'vercel' THEN 1 WHEN 'notion' THEN 2 ELSE 3 END
			 LIMIT 1`,
			)
			.get() as { id: string; name: string } | null;
		if (!sys) {
			db.close();
			return { system: "none", block: "(design DB returned no system)" };
		}
		const pal = db
			.query("SELECT * FROM color_palettes WHERE system_id = ?")
			.get(sys.id) as Record<string, string> | null;
		const typo = db
			.query("SELECT * FROM typography WHERE system_id = ?")
			.get(sys.id) as Record<string, string> | null;
		db.close();
		const lines = [`Design system: ${sys.name} (from the inbuilt design-system DB)`];
		if (pal) {
			lines.push("Color tokens (HSL - render as a DARK theme, invert background/foreground):");
			for (const k of ["accent_hsl", "primary_hsl", "muted_foreground_hsl", "border_hsl"]) {
				if (pal[k]) lines.push(`  --${k.replace("_hsl", "")}: hsl(${pal[k]})`);
			}
		}
		if (typo) {
			lines.push(`Typography: body ${typo.font_family}, headings ${typo.heading_font}`);
			if (typo.heading_sizes_json) lines.push(`  heading sizes: ${typo.heading_sizes_json}`);
		}
		return { system: sys.name, block: lines.join("\n") };
	} catch (err) {
		return { system: "error", block: `(design DB query failed: ${err})` };
	}
}

// --- model calls --------------------------------------------------------

async function callOllama(
	model: string,
	system: string,
	user: string,
	numPredict: number,
): Promise<string> {
	const res = await fetch("http://localhost:11434/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			stream: false,
			think: false, // skip the reasoning trace - this is what blew Round 1.
			options: { temperature: 0.4, num_predict: numPredict },
		}),
		signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
	const json = (await res.json()) as { message?: { content?: string } };
	return json.message?.content ?? "";
}

async function callLMStudio(
	baseUrl: string,
	model: string,
	system: string,
	user: string,
	maxTokens: number,
): Promise<string> {
	const res = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			temperature: 0.4,
			max_tokens: maxTokens,
		}),
		signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`lmstudio ${res.status}: ${(await res.text()).slice(0, 200)}`);
	const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
	return json.choices?.[0]?.message?.content ?? "";
}

async function callRole(
	a: RoleModelAssignment,
	system: string,
	user: string,
	budget: number,
): Promise<string> {
	if (a.provider === "ollama" || a.provider === "8gent") {
		return callOllama(a.model, system, user, budget);
	}
	if (a.provider === "lmstudio") {
		const base = process.env.LMSTUDIO_BASE_URL || "http://localhost:1234/v1";
		return callLMStudio(base, a.model, system, user, budget);
	}
	throw new Error(`arena does not drive provider '${a.provider}' for codegen`);
}

/** Warm a model so the timed steps do not pay the cold-load cost. */
async function warm(a: RoleModelAssignment): Promise<void> {
	try {
		log(`warming ${a.provider}/${a.model} ...`);
		await callRole(a, "Reply with: ok", "ok", 8);
		log(`warmed ${a.provider}/${a.model}`);
	} catch (err) {
		log(`warm failed for ${a.provider}/${a.model}: ${err}`);
	}
}

function extractHtml(text: string): string {
	const fence = text.match(/```(?:html)?\s*\n([\s\S]*?)```/);
	const body = fence ? fence[1] : text;
	const start = body.search(/<!doctype html|<html/i);
	return (start >= 0 ? body.slice(start) : body).trim();
}

async function step(
	name: string,
	a: RoleModelAssignment,
	fn: () => Promise<string>,
	results: RoleResult[],
): Promise<string> {
	log(`${name}: ${a.provider}/${a.model} ...`);
	const t0 = performance.now();
	try {
		const out = await fn();
		const ms = Math.round(performance.now() - t0);
		results.push({ step: name, provider: a.provider, model: a.model, ms, chars: out.length, ok: true });
		log(`${name} done (${ms}ms, ${out.length} chars)`);
		return out;
	} catch (err) {
		const ms = Math.round(performance.now() - t0);
		results.push({
			step: name,
			provider: a.provider,
			model: a.model,
			ms,
			chars: 0,
			ok: false,
			error: String(err),
		});
		log(`${name} FAILED (${ms}ms): ${err}`);
		return "";
	}
}

async function main(): Promise<void> {
	const roles = loadRoleConfig();
	mkdirSync(OUT_DIR, { recursive: true });
	log(`Arena ${ROUND} - three-model ensemble`);
	log(`  orchestrator ${roles.orchestrator.provider}/${roles.orchestrator.model}`);
	log(`  engineer     ${roles.engineer.provider}/${roles.engineer.model}`);
	log(`  qa           ${roles.qa.provider}/${roles.qa.model}`);

	const design = designTokens();
	log(`design DB: selected '${design.system}'`);

	// Warm both distinct models before the timed workflow.
	await warm(roles.orchestrator);
	if (roles.engineer.model !== roles.orchestrator.model) await warm(roles.engineer);

	const results: RoleResult[] = [];

	// 1. orchestrator plans (with design tokens in hand).
	const plan = await step(
		"orchestrator",
		roles.orchestrator,
		() =>
			callRole(
				roles.orchestrator,
				"You are the orchestrator. Produce a short numbered build plan. No code.",
				`${TASK}\n\nUse these design tokens:\n${design.block}\n\nProduce a concise numbered build plan an engineer can follow.`,
				1500,
			),
		results,
	);

	// 2. engineer writes the code.
	const draftRaw = await step(
		"engineer",
		roles.engineer,
		() =>
			callRole(
				roles.engineer,
				"You are the engineer. Write complete, correct, runnable code. Output only the file.",
				`${TASK}\n\nDesign tokens to use:\n${design.block}\n\nBuild plan:\n${plan || "(no plan - build directly from the requirements)"}`,
				8000,
			),
		results,
	);
	const draft = extractHtml(draftRaw);

	// 3. qa reviews.
	const review = await step(
		"qa",
		roles.qa,
		() =>
			callRole(
				roles.qa,
				"You are QA. List concrete defects and missing requirements only. Be harsh and specific.",
				`${TASK}\n\nSubmitted index.html:\n${draft}`,
				1500,
			),
		results,
	);

	// 4. engineer applies fixes.
	let final = draft;
	if (review && draft) {
		const finalRaw = await step(
			"engineer-fix",
			roles.engineer,
			() =>
				callRole(
					roles.engineer,
					"You are the engineer. Apply the QA fixes. Output only the complete corrected file.",
					`${TASK}\n\nCurrent index.html:\n${draft}\n\nQA defects to fix:\n${review}`,
					8000,
				),
			results,
		);
		const fixed = extractHtml(finalRaw);
		if (fixed.length > 400) final = fixed;
	}

	writeFileSync(join(OUT_DIR, "index.html"), final || "<!-- ensemble produced no artifact -->");
	writeFileSync(
		join(OUT_DIR, "run.json"),
		JSON.stringify(
			{
				round: ROUND,
				ts: new Date().toISOString(),
				roles,
				designSystem: design.system,
				results,
				plan,
				review,
				artifactChars: final.length,
				totalMs: results.reduce((s, r) => s + r.ms, 0),
				ensembleOk: results.every((r) => r.ok) && final.length > 400,
			},
			null,
			2,
		),
	);
	log(`WROTE ${join(OUT_DIR, "index.html")} (${final.length} chars)`);
	log(`total ensemble time: ${results.reduce((s, r) => s + r.ms, 0)}ms`);
	log(`ensemble ok: ${results.every((r) => r.ok) && final.length > 400}`);
}

main().catch((err) => {
	log(`ARENA FATAL: ${err}`);
	process.exit(1);
});
