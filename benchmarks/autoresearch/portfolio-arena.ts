#!/usr/bin/env bun
/**
 * portfolio-arena.ts - end-to-end workflow run for the AutoResearch
 * head-to-head: the three local models build a deliverable as one system.
 *
 * Workflow (each role -> its strength, per ~/.8gent/roles.json):
 *   1. orchestrator  plans the build
 *   2. engineer      writes the code from the plan
 *   3. qa            reviews the code, lists concrete defects
 *   4. engineer      applies the fixes
 *
 * The deliverable is a single self-contained index.html: an animated 3D
 * portfolio hero (Three.js via CDN). Single-file so it is trivially
 * screenshotted and deployed.
 *
 *   bun run benchmarks/autoresearch/portfolio-arena.ts
 *
 * Output: benchmarks/autoresearch/arena/<round>/8gent/index.html + run.json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadRoleConfig, type RoleModelAssignment } from "../../packages/orchestration/role-config";

const ROUND = process.env.ARENA_ROUND ?? "round-1";
const OUT_DIR = join(import.meta.dir, "arena", ROUND, "8gent");
const CALL_TIMEOUT_MS = 600_000;

const TASK = `Build a single-file animated 3D portfolio hero section as index.html.
Requirements:
- A full-viewport Three.js scene loaded from the unpkg CDN (three@0.160.0).
- An animated 3D centerpiece: a geometry that rotates continuously and reacts to mouse movement.
- Tasteful lighting (ambient + directional). Dark background, no purple or pink hues.
- Overlaid HTML: a name headline "James Spalding", a one-line role subtitle, and one call-to-action button.
- Responsive: the canvas resizes with the window; readable on mobile.
- requestAnimationFrame loop with proper cleanup. No build step, no npm. Pure HTML+JS+CSS in one file.
Output ONLY the complete contents of index.html, nothing else.`;

interface RoleResult {
	role: string;
	provider: string;
	model: string;
	ms: number;
	chars: number;
}

function log(msg: string): void {
	console.log(`[${new Date().toISOString()}] ${msg}`);
}

/** Call Ollama's chat API. */
async function callOllama(model: string, system: string, user: string): Promise<string> {
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
			options: { temperature: 0.4 },
		}),
		signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
	const json = (await res.json()) as { message?: { content?: string } };
	return json.message?.content ?? "";
}

/** Call an OpenAI-compatible endpoint (LM Studio). */
async function callOpenAICompat(
	baseUrl: string,
	model: string,
	system: string,
	user: string,
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
			max_tokens: 8192,
		}),
		signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`lmstudio ${res.status}: ${await res.text()}`);
	const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
	return json.choices?.[0]?.message?.content ?? "";
}

/** Route a call to the provider named in the role assignment. */
async function callRole(
	a: RoleModelAssignment,
	system: string,
	user: string,
): Promise<string> {
	if (a.provider === "ollama" || a.provider === "8gent") {
		return callOllama(a.model, system, user);
	}
	if (a.provider === "lmstudio") {
		const base = process.env.LMSTUDIO_BASE_URL || "http://localhost:1234/v1";
		return callOpenAICompat(base, a.model, system, user);
	}
	throw new Error(`arena does not drive provider '${a.provider}' for codegen`);
}

/** Strip markdown code fences so the artifact is raw HTML. */
function extractHtml(text: string): string {
	const fence = text.match(/```(?:html)?\s*\n([\s\S]*?)```/);
	const body = fence ? fence[1] : text;
	const start = body.search(/<!doctype html|<html/i);
	return (start >= 0 ? body.slice(start) : body).trim();
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
	const t0 = performance.now();
	const out = await fn();
	return [out, Math.round(performance.now() - t0)];
}

async function main(): Promise<void> {
	const roles = loadRoleConfig();
	mkdirSync(OUT_DIR, { recursive: true });
	log(`Arena ${ROUND} - three-model ensemble`);
	log(`  orchestrator ${roles.orchestrator.provider}/${roles.orchestrator.model}`);
	log(`  engineer     ${roles.engineer.provider}/${roles.engineer.model}`);
	log(`  qa           ${roles.qa.provider}/${roles.qa.model}`);
	const results: RoleResult[] = [];

	// 1. orchestrator plans
	log("orchestrator: planning...");
	const [plan, planMs] = await timed(() =>
		callRole(
			roles.orchestrator,
			"You are the orchestrator. Plan the build. Be concrete and brief. No code.",
			`${TASK}\n\nProduce a short numbered build plan an engineer can follow.`,
		),
	);
	results.push({
		role: "orchestrator",
		provider: roles.orchestrator.provider,
		model: roles.orchestrator.model,
		ms: planMs,
		chars: plan.length,
	});
	log(`orchestrator done (${planMs}ms, ${plan.length} chars)`);

	// 2. engineer writes the code
	log("engineer: writing index.html...");
	const [draftRaw, draftMs] = await timed(() =>
		callRole(
			roles.engineer,
			"You are the engineer. Write complete, correct, runnable code. Output only the file.",
			`${TASK}\n\nBuild plan:\n${plan}`,
		),
	);
	const draft = extractHtml(draftRaw);
	results.push({
		role: "engineer",
		provider: roles.engineer.provider,
		model: roles.engineer.model,
		ms: draftMs,
		chars: draft.length,
	});
	log(`engineer draft done (${draftMs}ms, ${draft.length} chars)`);

	// 3. qa reviews
	log("qa: reviewing...");
	const [review, reviewMs] = await timed(() =>
		callRole(
			roles.qa,
			"You are QA. Review the HTML for bugs and missing requirements. List concrete defects only. Be harsh.",
			`${TASK}\n\nSubmitted index.html:\n${draft}`,
		),
	);
	results.push({
		role: "qa",
		provider: roles.qa.provider,
		model: roles.qa.model,
		ms: reviewMs,
		chars: review.length,
	});
	log(`qa done (${reviewMs}ms, ${review.length} chars)`);

	// 4. engineer applies fixes
	log("engineer: applying fixes...");
	const [finalRaw, fixMs] = await timed(() =>
		callRole(
			roles.engineer,
			"You are the engineer. Apply the QA fixes. Output only the complete corrected file.",
			`${TASK}\n\nCurrent index.html:\n${draft}\n\nQA defects to fix:\n${review}`,
		),
	);
	const final = extractHtml(finalRaw);
	results.push({
		role: "engineer-fix",
		provider: roles.engineer.provider,
		model: roles.engineer.model,
		ms: fixMs,
		chars: final.length,
	});
	log(`engineer fix done (${fixMs}ms, ${final.length} chars)`);

	const artifact = final.length > 200 ? final : draft;
	writeFileSync(join(OUT_DIR, "index.html"), artifact);
	writeFileSync(
		join(OUT_DIR, "run.json"),
		JSON.stringify(
			{
				round: ROUND,
				ts: new Date().toISOString(),
				roles,
				results,
				plan,
				review,
				artifactChars: artifact.length,
				totalMs: results.reduce((s, r) => s + r.ms, 0),
			},
			null,
			2,
		),
	);
	log(`WROTE ${join(OUT_DIR, "index.html")} (${artifact.length} chars)`);
	log(`total ensemble time: ${results.reduce((s, r) => s + r.ms, 0)}ms`);
}

main().catch((err) => {
	log(`ARENA FAILED: ${err}`);
	process.exit(1);
});
