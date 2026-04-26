/**
 * HyperAgent - Self-improvement loop for LinkedIn outreach.
 *
 * Runs on a schedule. Analyzes template performance, identifies underperformers,
 * rewrites them via LLM (model proxy), saves evolved templates to DB.
 * Evolution entries logged to ~/.8gent/evolution/linkedin-evolution.db
 *
 * This is what makes us smarter than GojiberryAI:
 * their system improves when humans adjust it.
 * Ours improves while you sleep.
 */

import {
	getDb,
	getTemplates,
	upsertTemplate,
	getCampaignStats,
} from "./campaign-db";
import { randomId } from "./utils";
import type { MessageTemplate } from "./types";

const MODEL_PROXY_URL =
	process.env.MODEL_PROXY_URL || "http://8gi-model-proxy.internal:3200";
const REFLECTION_THRESHOLD = 20; // min sends before template is eligible for evolution
const UNDERPERFORM_RATE = 0.03; // below 3% reply rate = rewrite
const REFLECTION_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

// ── LLM call via model proxy ──────────────────────────────────────────

async function callLLM(prompt: string): Promise<string> {
	try {
		const res = await fetch(`${MODEL_PROXY_URL}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "auto",
				messages: [
					{
						role: "system",
						content:
							"You are an expert LinkedIn outreach copywriter. You write short, direct, non-salesy messages that lead with a real signal about the recipient. Never use cliches. Max 300 chars for connection notes, 500 chars for messages.",
					},
					{ role: "user", content: prompt },
				],
				max_tokens: 300,
				temperature: 0.7,
			}),
		});
		if (!res.ok) throw new Error(`Model proxy ${res.status}`);
		const data = await res.json();
		return data?.choices?.[0]?.message?.content?.trim() || "";
	} catch (e: any) {
		console.error("[hyperagent] LLM call failed:", e.message);
		return "";
	}
}

// ── Evolution log ─────────────────────────────────────────────────────

interface EvolutionEntry {
	id: string;
	timestamp: string;
	originalTemplateId: string;
	newTemplateId: string;
	reason: string;
	originalReplyRate: number;
	originalBody: string;
	newBody: string;
}

function logEvolution(entry: EvolutionEntry): void {
	const db = getDb();
	db.exec(`
    CREATE TABLE IF NOT EXISTS template_evolution (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      original_template_id TEXT NOT NULL,
      new_template_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      original_reply_rate REAL NOT NULL,
      original_body TEXT NOT NULL,
      new_body TEXT NOT NULL
    );
  `);
	db.prepare(`
    INSERT INTO template_evolution VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
		entry.id,
		entry.timestamp,
		entry.originalTemplateId,
		entry.newTemplateId,
		entry.reason,
		entry.originalReplyRate,
		entry.originalBody,
		entry.newBody,
	);
}

// ── Core reflection logic ─────────────────────────────────────────────

export async function reflect(): Promise<{
	evolved: number;
	skipped: number;
	details: string[];
}> {
	const templates = getTemplates();
	const details: string[] = [];
	let evolved = 0;
	let skipped = 0;

	// Find underperformers with enough data to judge
	const underperformers = templates.filter(
		(t) =>
			t.sendCount >= REFLECTION_THRESHOLD && t.replyRate < UNDERPERFORM_RATE,
	);

	// Find top performers for reference
	const topPerformers = templates
		.filter((t) => t.sendCount >= REFLECTION_THRESHOLD && t.replyRate > 0.08)
		.slice(0, 3);

	const topExamples = topPerformers
		.map((t) => `"${t.body}" (${(t.replyRate * 100).toFixed(1)}% reply rate)`)
		.join("\n");

	for (const template of underperformers) {
		const prompt = `
Rewrite this LinkedIn ${template.type} template. It has only ${(template.replyRate * 100).toFixed(1)}% reply rate (${template.sendCount} sends, ${template.replyCount} replies).

CURRENT (underperforming):
"${template.body}"

Signal hook this template should use: "${template.signalHook}"

TOP PERFORMING examples for reference:
${topExamples || "None yet - focus on specificity and a real hook."}

Rules:
- Lead with the signal hook, make it specific
- One ask only (call OR reply, not both)
- No "I came across your profile"
- No "I'd love to connect"
- ${template.type === "connection_request" ? "Max 300 chars" : "Max 500 chars"}
- Sound like a human, not a template

Return ONLY the new message text, nothing else.
`.trim();

		const newBody = await callLLM(prompt);
		if (!newBody || newBody.length < 20) {
			skipped++;
			details.push(`SKIP ${template.name}: LLM returned empty`);
			continue;
		}

		const newTemplate: MessageTemplate = {
			id: randomId(),
			name: `${template.name} v${template.version + 1}`,
			type: template.type,
			body: newBody,
			signalHook: template.signalHook,
			sendCount: 0,
			replyCount: 0,
			replyRate: 0,
			version: template.version + 1,
			evolvedFromId: template.id,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		upsertTemplate(newTemplate);
		logEvolution({
			id: randomId(),
			timestamp: new Date().toISOString(),
			originalTemplateId: template.id,
			newTemplateId: newTemplate.id,
			reason: `Reply rate ${(template.replyRate * 100).toFixed(1)}% below ${UNDERPERFORM_RATE * 100}% threshold after ${template.sendCount} sends`,
			originalReplyRate: template.replyRate,
			originalBody: template.body,
			newBody,
		});

		evolved++;
		details.push(
			`EVOLVED ${template.name}: ${(template.replyRate * 100).toFixed(1)}% → testing v${template.version + 1}`,
		);
		console.log(`[hyperagent] Evolved template: ${template.name}`);
	}

	return { evolved, skipped, details };
}

// ── Identify winning patterns ─────────────────────────────────────────

export function getInsights(): string {
	const templates = getTemplates();
	const eligible = templates.filter((t) => t.sendCount >= 10);

	if (eligible.length === 0)
		return "Not enough data yet. Need at least 10 sends per template.";

	const top = eligible.filter((t) => t.replyRate > 0.08);
	const bottom = eligible.filter((t) => t.replyRate < UNDERPERFORM_RATE);

	const lines: string[] = [
		`Analyzing ${eligible.length} templates (${templates.length} total)`,
		`Top performers (>8% reply rate): ${top.length}`,
		`Underperformers (<3% reply rate): ${bottom.length}`,
		"",
	];

	if (top.length > 0) {
		lines.push("TOP PERFORMERS:");
		for (const t of top.slice(0, 3)) {
			lines.push(
				`  ${t.name}: ${(t.replyRate * 100).toFixed(1)}% (${t.sendCount} sends)`,
			);
			lines.push(`  Hook: "${t.signalHook}"`);
		}
	}

	if (bottom.length > 0) {
		lines.push("\nUNDERPERFORMERS (scheduled for evolution):");
		for (const t of bottom.slice(0, 3)) {
			lines.push(
				`  ${t.name}: ${(t.replyRate * 100).toFixed(1)}% (${t.sendCount} sends)`,
			);
		}
	}

	return lines.join("\n");
}

// ── Scheduler ─────────────────────────────────────────────────────────

let reflectionTimer: ReturnType<typeof setInterval> | null = null;

export function startReflectionLoop(): void {
	if (reflectionTimer) return;
	console.log("[hyperagent] Starting reflection loop (every 6h)");

	reflectionTimer = setInterval(async () => {
		console.log("[hyperagent] Running reflection...");
		const result = await reflect();
		console.log(
			`[hyperagent] Reflection complete. Evolved: ${result.evolved}, Skipped: ${result.skipped}`,
		);
		if (result.details.length > 0) {
			console.log("[hyperagent] Details:", result.details.join("; "));
		}
	}, REFLECTION_INTERVAL_MS);
}

export function stopReflectionLoop(): void {
	if (reflectionTimer) {
		clearInterval(reflectionTimer);
		reflectionTimer = null;
	}
}
