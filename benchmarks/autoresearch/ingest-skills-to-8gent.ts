#!/usr/bin/env bun
/**
 * ingest-skills-to-8gent.ts
 *
 * Scans James's Claude Code skills collection and transforms them
 * into 8gent-compatible SkillSummary format, writing to ~/.8gent/skills/
 * and rebuilding the skill registry index.
 *
 * Source paths:
 *   ~/.claude/skills/
 *   ~/Myresumeportfolio/.claude/skills/
 *
 * Target: ~/.8gent/skills/
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

const HOME = homedir();
const TARGET_DIR = join(HOME, ".8gent", "skills");
const INDEX_FILE = join(TARGET_DIR, ".index.json");

// Source skill directories
const SOURCES = [
	join(HOME, ".claude", "skills"),
	join(HOME, "Myresumeportfolio", ".claude", "skills"),
];

// Skills to skip (system-level, not useful for 8gent)
const SKIP = new Set([
	"CORE",
	"template-skill",
	"skill-index.json",
	"no-bullshit.md",
	"nick-speech-anatomy.md",
	"phoneme-video-generator.md",
	"suno-music-generator.md",
	"Suno.md",
	"quarantine",
	"SkillQuarantine",
]);

interface SkillSummary {
	name: string;
	description: string;
	capabilities: string[];
	triggers: string[];
	tokenEstimate: number;
	source: string;
	category: string;
}

// Category mapping based on skill name patterns
function categorize(name: string, desc: string): string {
	const combined = `${name} ${desc}`.toLowerCase();
	if (combined.match(/design|ui|ux|css|frontend|theme|canvas|art/))
		return "design";
	if (combined.match(/security|0din|penetration|vuln/)) return "security";
	if (combined.match(/git|github|pr|branch|commit|workflow/)) return "devops";
	if (combined.match(/test|vitest|tdd|debug/)) return "testing";
	if (combined.match(/browser|automation|electron|slack/)) return "automation";
	if (combined.match(/video|music|audio|elevenlabs|remotion/))
		return "creative";
	if (combined.match(/docker|vessel|deploy|ci|cd/)) return "infrastructure";
	if (combined.match(/api|mcp|sdk|claude|agent/)) return "ai-tools";
	if (combined.match(/email|outreach|social|engagement/)) return "business";
	if (combined.match(/quant|trading|flight|deal/)) return "personal";
	if (combined.match(/plan|project|issue|brainstorm/)) return "planning";
	if (combined.match(/react|next|vercel|svelte/)) return "frameworks";
	if (combined.match(/doc|pdf|xlsx|pptx|word/)) return "documents";
	if (combined.match(/scientific|image|data/)) return "science";
	return "general";
}

function extractCapabilities(content: string, name: string): string[] {
	const caps: string[] = [];

	// Extract from frontmatter if present
	const fmMatch = content.match(/capabilities:\s*\[(.*?)\]/s);
	if (fmMatch) {
		caps.push(
			...fmMatch[1]
				.split(",")
				.map((s) => s.trim().replace(/['"]/g, ""))
				.filter(Boolean),
		);
	}

	// Infer from content
	if (content.includes("browser") || content.includes("navigate"))
		caps.push("browser-automation");
	if (content.includes("git ") || content.includes("commit"))
		caps.push("version-control");
	if (content.includes("test") || content.includes("assert"))
		caps.push("testing");
	if (content.includes("deploy") || content.includes("Docker"))
		caps.push("deployment");
	if (content.includes("API") || content.includes("endpoint"))
		caps.push("api-integration");
	if (content.includes("design") || content.includes("CSS"))
		caps.push("design");
	if (content.includes("animation") || content.includes("motion"))
		caps.push("animation");
	if (content.includes("security") || content.includes("vulnerability"))
		caps.push("security");
	if (content.includes("email") || content.includes("outreach"))
		caps.push("communication");
	if (content.includes("data") || content.includes("analytics"))
		caps.push("data-analysis");

	return [...new Set(caps)].slice(0, 8);
}

function extractTriggers(content: string, name: string): string[] {
	const triggers: string[] = [];

	// Extract "USE WHEN" patterns
	const useWhen = content.match(/USE WHEN[:\s]+(.*?)(?:\.|$)/gim);
	if (useWhen) {
		triggers.push(
			...useWhen.map((m) => m.replace(/USE WHEN[:\s]+/i, "").trim()),
		);
	}

	// Extract "Use when" from description
	const useWhenDesc = content.match(/Use when[:\s]+(.*?)(?:\.|$)/gm);
	if (useWhenDesc) {
		triggers.push(
			...useWhenDesc.map((m) => m.replace(/Use when[:\s]+/i, "").trim()),
		);
	}

	// Add name-based trigger
	triggers.push(
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, " ")
			.trim(),
	);

	return [...new Set(triggers)].slice(0, 5);
}

function parseSkillFile(filePath: string): SkillSummary | null {
	try {
		const content = readFileSync(filePath, "utf-8");

		// Extract frontmatter
		const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
		let name = basename(filePath, extname(filePath));
		let description = "";

		if (fmMatch) {
			const fm = fmMatch[1];
			const nameMatch = fm.match(/name:\s*(.+)/);
			const descMatch = fm.match(/description:\s*>?\s*\n?\s*(.+)/);
			if (nameMatch) name = nameMatch[1].trim().replace(/^['"]|['"]$/g, "");
			if (descMatch)
				description = descMatch[1].trim().replace(/^['"]|['"]$/g, "");
		}

		if (!description) {
			// Try first heading or paragraph
			const h1 = content.match(/^#\s+(.+)/m);
			if (h1) description = h1[1];
			else description = content.slice(0, 100).replace(/\n/g, " ").trim();
		}

		return {
			name,
			description: description.slice(0, 200),
			capabilities: extractCapabilities(content, name),
			triggers: extractTriggers(content, name),
			tokenEstimate: Math.ceil(content.length / 4),
			source: filePath,
			category: categorize(name, description),
		};
	} catch {
		return null;
	}
}

function scanDirectory(dir: string): SkillSummary[] {
	const skills: SkillSummary[] = [];
	if (!existsSync(dir)) return skills;

	const entries = readdirSync(dir);

	for (const entry of entries) {
		if (SKIP.has(entry)) continue;

		const fullPath = join(dir, entry);
		const stat = statSync(fullPath);

		if (stat.isDirectory()) {
			// Look for SKILL.md inside
			const skillMd = join(fullPath, "SKILL.md");
			if (existsSync(skillMd)) {
				const skill = parseSkillFile(skillMd);
				if (skill) skills.push(skill);
			}
		} else if (entry.endsWith(".md") && !entry.startsWith(".")) {
			const skill = parseSkillFile(fullPath);
			if (skill) skills.push(skill);
		}
	}

	return skills;
}

function main() {
	console.log(
		"╔══════════════════════════════════════════════════════════════╗",
	);
	console.log("║     8gent Skill Ingestion — Populating the Toolshed       ║");
	console.log(
		"╚══════════════════════════════════════════════════════════════╝",
	);
	console.log("");

	mkdirSync(TARGET_DIR, { recursive: true });

	const allSkills: SkillSummary[] = [];

	for (const source of SOURCES) {
		console.log(`Scanning: ${source}`);
		const found = scanDirectory(source);
		console.log(`  Found: ${found.length} skills`);
		allSkills.push(...found);
	}

	// Deduplicate by name
	const seen = new Set<string>();
	const unique = allSkills.filter((s) => {
		const key = s.name.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});

	console.log(`\nTotal unique skills: ${unique.length}`);

	// Write each skill as a .md file to target
	for (const skill of unique) {
		const slug = skill.name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/(^-|-$)/g, "");
		const targetPath = join(TARGET_DIR, `${slug}.md`);

		// Copy source content + add 8gent frontmatter
		let content: string;
		try {
			content = readFileSync(skill.source, "utf-8");
		} catch {
			continue;
		}

		// Add/replace frontmatter with 8gent format
		const newFrontmatter = `---
name: ${skill.name}
description: ${skill.description}
capabilities: [${skill.capabilities.map((c) => `"${c}"`).join(", ")}]
triggers: [${skill.triggers.map((t) => `"${t}"`).join(", ")}]
category: ${skill.category}
tokenEstimate: ${skill.tokenEstimate}
source: ${skill.source}
---`;

		// Replace existing frontmatter or prepend
		const bodyMatch = content.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/);
		const body = bodyMatch ? bodyMatch[1] : content;

		writeFileSync(targetPath, `${newFrontmatter}\n\n${body}`);
	}

	// Write index
	const categories = new Map<string, number>();
	for (const s of unique) {
		categories.set(s.category, (categories.get(s.category) || 0) + 1);
	}

	const index = {
		version: 1,
		lastUpdated: new Date().toISOString(),
		skillCount: unique.length,
		categories: Object.fromEntries(categories),
		totalTokens: unique.reduce((sum, s) => sum + s.tokenEstimate, 0),
		skills: unique.map((s) => ({
			name: s.name,
			description: s.description,
			capabilities: s.capabilities,
			triggers: s.triggers,
			tokenEstimate: s.tokenEstimate,
			category: s.category,
		})),
	};

	writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));

	// Summary
	console.log("\n  Category breakdown:");
	for (const [cat, count] of [...categories.entries()].sort(
		(a, b) => b[1] - a[1],
	)) {
		console.log(`    ${cat.padEnd(20)} ${count} skills`);
	}

	console.log(`\n  Total tokens: ${index.totalTokens.toLocaleString()}`);
	console.log(`  Written to: ${TARGET_DIR}`);
	console.log(`  Index: ${INDEX_FILE}`);
	console.log("\n  8gent's toolshed is loaded. Mwah ha ha.");
}

main();
