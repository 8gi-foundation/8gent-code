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
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadRoleConfig, type RoleModelAssignment } from "../../packages/orchestration/role-config";
import { unloadOllamaModel } from "../../packages/orchestration/local-model-detect";

const ROUND = process.env.ARENA_ROUND ?? "round-2";
const REPO_ROOT = join(import.meta.dir, "..", "..");
const OUT_DIR = join(import.meta.dir, "arena", ROUND, "8gent");
const DESIGN_DB = join(REPO_ROOT, "data", "design-systems.db");
const BRIDGE_PATH =
	process.env.APPLE_FOUNDATION_BRIDGE ||
	join(homedir(), ".8gent", "bin", "apple-foundation-bridge");
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
		// Not readonly: bun:sqlite cannot open a WAL-mode DB read-only
		// (it needs write access to the -shm sidecar). We only read.
		const db = new Database(DESIGN_DB);
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
	const json = (await res.json()) as {
		choices?: { message?: { content?: string; reasoning_content?: string } }[];
	};
	const msg = json.choices?.[0]?.message;
	// gemma-4-26b-a4b is a reasoning model: real output lands in `content`
	// after the trace. Fall back to reasoning_content so a run never returns
	// empty if the model spent its budget thinking.
	return msg?.content || msg?.reasoning_content || "";
}

/**
 * Drive the Apple Foundation model via its bridge binary (JSON-line IPC over
 * stdin/stdout). One request per spawn - the arena makes few, large calls.
 */
function callAppleFoundation(system: string, user: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn(BRIDGE_PATH, [], { stdio: ["pipe", "pipe", "ignore"] });
		let buf = "";
		const timer = setTimeout(() => {
			proc.kill();
			reject(new Error("apple-foundation bridge timed out"));
		}, 120_000);
		proc.stdout.on("data", (c) => {
			buf += c;
			const nl = buf.indexOf("\n");
			if (nl === -1) return;
			clearTimeout(timer);
			proc.kill();
			try {
				const r = JSON.parse(buf.slice(0, nl)) as {
					message?: { content?: string };
					error?: string;
				};
				if (r.error) reject(new Error(`apple-foundation: ${r.error}`));
				else resolve(r.message?.content ?? "");
			} catch (err) {
				reject(new Error(`apple-foundation bad JSON: ${err}`));
			}
		});
		proc.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		proc.stdin.write(
			`${JSON.stringify({
				model: "apple-foundationmodel",
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
			})}\n`,
		);
	});
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

/**
 * Programmatic render-readiness check. This is the functional QA gate -
 * it catches the structural failures an LLM reviewer reads past (a
 * truncated file, a render loop that is never started). Returns concrete
 * defect strings that get fed straight into the engineer-fix step.
 */
function staticChecks(html: string): string[] {
	const d: string[] = [];
	if (!/<\/html>\s*$/i.test(html.trim()))
		d.push("File is TRUNCATED - it does not end with </html>. Output the COMPLETE file.");
	if (!/renderer\.render\s*\(/.test(html))
		d.push("renderer.render() is never called - the 3D scene will never paint. Add it inside the animation loop.");
	if (!/requestAnimationFrame/.test(html))
		d.push("No requestAnimationFrame loop.");
	if (
		!/\b(animate|init|start|main)\s*\(\s*\)\s*;/.test(html) &&
		!/new\s+[A-Z]\w*\s*\(/.test(html)
	)
		d.push("The animation loop / class is defined but never invoked at top level - nothing starts.");
	if (!/three@0\.16/.test(html)) d.push("Three.js 0.160 CDN import is missing.");
	return d;
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
	// Non-destructive engineer override: lets the arena route around a
	// wedged provider (e.g. LM Studio "Compute error") without rewriting
	// roles.json. Arena-scoped only; the real harness config is untouched.
	if (process.env.ARENA_ENGINEER_PROVIDER && process.env.ARENA_ENGINEER_MODEL) {
		roles.engineer = {
			provider: process.env.ARENA_ENGINEER_PROVIDER as RoleModelAssignment["provider"],
			model: process.env.ARENA_ENGINEER_MODEL,
		};
	}
	mkdirSync(OUT_DIR, { recursive: true });
	log(`Arena ${ROUND} - three-model ensemble`);
	log(`  orchestrator ${roles.orchestrator.provider}/${roles.orchestrator.model}`);
	log(`  engineer     ${roles.engineer.provider}/${roles.engineer.model}`);
	log(`  qa           ${roles.qa.provider}/${roles.qa.model}`);

	const design = designTokens();
	log(`design DB: selected '${design.system}'`);

	// Memory time-sharing: on one machine the local models cannot co-reside
	// (a resident 27B model starves the next). Free an Ollama model as soon
	// as its step is done, and warm each model only just before it runs.
	const freeIfOllama = async (a: RoleModelAssignment): Promise<void> => {
		if (a.provider === "ollama" || a.provider === "8gent") {
			log(`unloading ${a.model} to free memory`);
			await unloadOllamaModel(a.model);
		}
	};

	const results: RoleResult[] = [];

	// 1. orchestrator plans (with design tokens in hand).
	await warm(roles.orchestrator);
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
	// Release only when the engineer uses a different model - no point
	// unloading then reloading the same one.
	if (roles.orchestrator.model !== roles.engineer.model) {
		await freeIfOllama(roles.orchestrator);
	}

	// 1b. context manager (Apple Foundation): compress the plan + tokens
	// into a tight engineer brief. Flow and context management is the
	// on-device model's strength, and this puts the third local model
	// into the workflow proper rather than leaving it as a dead fallback.
	const appleAssignment: RoleModelAssignment = {
		provider: "apple-foundation",
		model: "apple-foundationmodel",
	};
	const brief = await step(
		"context",
		appleAssignment,
		() =>
			callAppleFoundation(
				"Compress this into a tight engineer brief. Keep every requirement and token. No preamble.",
				// Apple Foundation has a 4096-token window (input + output).
				// Hard-cap the input so the compaction step never overflows.
				`Build plan:\n${plan.slice(0, 1200)}\n\nDesign tokens:\n${design.block.slice(0, 500)}`,
			),
		results,
	);

	// 2. engineer writes the code from the compacted brief.
	await warm(roles.engineer);
	const engineerContext = brief || plan || "(build directly from the requirements)";
	const draftRaw = await step(
		"engineer",
		roles.engineer,
		() =>
			callRole(
				roles.engineer,
				"You are the engineer. Write complete, correct, runnable code. The file MUST end with </html>. Output only the file.",
				`${TASK}\n\nDesign tokens to use:\n${design.block}\n\nEngineer brief:\n${engineerContext}`,
				16000,
			),
		results,
	);
	const draft = extractHtml(draftRaw);

	// 3. qa reviews.
	await warm(roles.qa);
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
	if (roles.qa.model !== roles.engineer.model) {
		await freeIfOllama(roles.qa); // release before the engineer model runs again.
	}

	// Functional QA gate: programmatic render-readiness checks, merged with
	// the LLM review. This is what catches the truncation / dead-render-loop
	// failures the LLM reviewer reads straight past.
	const draftDefects = staticChecks(draft);
	if (draftDefects.length > 0) {
		log(`static checks found ${draftDefects.length} defect(s) in the draft`);
	}
	const fullReview = [review, ...(draftDefects.length ? ["Automated render checks (MUST fix):", ...draftDefects] : [])].join("\n");

	// 4. engineer applies fixes.
	let final = draft;
	if (fullReview.trim() && draft) {
		await warm(roles.engineer); // re-warm in case the qa model load evicted it.
		const finalRaw = await step(
			"engineer-fix",
			roles.engineer,
			() =>
				callRole(
					roles.engineer,
					"You are the engineer. Apply every fix. Output the COMPLETE corrected file, ending with </html>. Output only the file.",
					`${TASK}\n\nCurrent index.html:\n${draft}\n\nDefects to fix:\n${fullReview}`,
					16000,
				),
			results,
		);
		const fixed = extractHtml(finalRaw);
		// Pick whichever candidate passes more functional checks; on a tie,
		// keep the draft unless the fix is a complete, comparably-sized doc.
		const fixDefects = staticChecks(fixed);
		const fixComplete = fixed.length >= draft.length * 0.7 && /<\/html>/i.test(fixed);
		if (fixed.length > 400 && fixDefects.length < draftDefects.length) {
			final = fixed;
			log(`fix accepted (${fixDefects.length} defects vs draft ${draftDefects.length})`);
		} else if (fixComplete && fixDefects.length <= draftDefects.length) {
			final = fixed;
			log("fix accepted (complete, no worse than draft)");
		} else {
			log(`fix rejected (${fixed.length}ch, ${fixDefects.length} defects) - keeping draft`);
		}
	}
	const finalDefects = staticChecks(final);
	log(`final artifact: ${final.length}ch, ${finalDefects.length} static defect(s)`);

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
				staticDefects: finalDefects,
				ensembleOk:
					results.every((r) => r.ok) && final.length > 400 && finalDefects.length === 0,
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
