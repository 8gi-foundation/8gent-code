/**
 * LessonCollector - Step 2 of the usage-signal RL pipeline (#2752).
 *
 * Feeds two real, local, user-owned lesson sources into the kernel as labeled
 * negative/positive training examples:
 *
 *   - The LiveDemo ledger (~/.8gent/livedemo-ledger.jsonl): the demo-fix loop
 *     records each failing check (negative) and each diagnosed fix (positive).
 *   - Selfheal audit reports (~/.8gent/self-heal/reports/*.md): each finding
 *     carries the shipped defect (negative) and the auditor's suggested fix
 *     (positive).
 *
 * Same hard guarantees as TraceCapture (step 1):
 *
 *   - Opt-in: OFF by default. Only `training_proxy.lessonFeeds: true` in
 *     .8gent/config.json enables it. When off, every method is a no-op.
 *   - Local only: lessons append to .8gent/kernel/training/lessons.jsonl.
 *     This module has no network path.
 *   - PII-scrubbed at collection: redact() (secrets) then anonymize() (PII)
 *     run on every field BEFORE any byte hits disk. If anything secret- or
 *     PII-shaped survives both passes, that lesson is dropped. Fail closed
 *     per lesson: one dirty entry never blocks the clean ones.
 *
 * Where a negative and a positive exist for the same ref (a failing check
 * that was later fixed; a finding's defect vs its fix), `lessonsToGrpoPairs`
 * emits a genuine preference pair for the trainer. Both texts come straight
 * from the source records - no preference is ever fabricated.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { redact } from "../memory/redact";
import { containsSecret } from "../permissions/goal-secret-scrub";
import { anonymize, containsPii } from "../permissions/pii-anonymizer";
import type { GrpoPair } from "./pair-adapter";

/** One line of the LiveDemo ledger, as written by livedemo.py. */
export interface LiveDemoEntry {
	surface: string;
	check: string;
	/** "fail" (check failed) or "fixed" (a fix landed / re-demo passed) */
	status: string;
	/** Whether the finding is still open */
	open?: boolean;
	/** What went wrong, as diagnosed at demo time */
	cause?: string;
	/** What resolved it, recorded when status is "fixed" */
	fix?: string;
	commit?: string;
	/** Epoch seconds */
	ts?: number;
}

/** One finding parsed from a selfheal markdown report. */
export interface SelfHealFinding {
	severity: string;
	title: string;
	file: string;
	line: string;
	why: string;
	suggestedFix: string;
	/** ISO date of the report the finding came from (YYYY-MM-DD), if present */
	reportDate?: string;
}

/** A labeled training example derived from a lesson source. */
export interface LessonExample {
	source: "livedemo" | "selfheal";
	/** positive = a real recorded fix; negative = a real recorded failure */
	polarity: "positive" | "negative";
	/** Stable reference to the underlying lesson (surface:check or file:line) */
	ref: string;
	/** Shared per-ref task framing, so negatives and positives contrast */
	prompt: string;
	/** The recorded behavior: diagnosis only (negative) or diagnosis + fix (positive) */
	response: string;
	/** 1 for positive, 0 for negative - polarity as a reward label */
	score: number;
	/** When the underlying lesson happened (epoch ms) */
	occurredAt: number;
}

export interface LessonSources {
	/** Default: ~/.8gent/livedemo-ledger.jsonl */
	liveDemoLedgerPath?: string;
	/** Default: ~/.8gent/self-heal/reports */
	selfHealReportsDir?: string;
}

export interface CollectResult {
	/** Lessons newly appended to lessons.jsonl in this run */
	collected: number;
	/** Lessons already on disk from a previous run (dedupe hits) */
	duplicates: number;
	/** Lessons dropped because a secret or PII survived scrubbing */
	dropped: number;
}

/**
 * Scrub a single text field: redact secrets, then anonymize PII.
 * Returns null when something secret- or PII-shaped survives both passes,
 * meaning the caller must drop that lesson.
 */
function scrubField(text: string): string | null {
	const safe = anonymize(redact(text)).text;
	if (containsSecret(safe) || containsPii(safe)) return null;
	return safe;
}

/** Parse the LiveDemo JSONL ledger. Malformed lines are skipped. */
export function parseLiveDemoLedger(text: string): LiveDemoEntry[] {
	const entries: LiveDemoEntry[] = [];
	for (const line of text.split("\n")) {
		const s = line.trim();
		if (!s) continue;
		try {
			const parsed = JSON.parse(s) as LiveDemoEntry;
			if (typeof parsed?.surface === "string" && typeof parsed?.check === "string") {
				entries.push(parsed);
			}
		} catch {
			// Skip a malformed line rather than abort the whole ledger.
		}
	}
	return entries;
}

/**
 * Parse one selfheal markdown report (the buildReport format of self-heal.ts):
 *
 *   # self-heal report YYYY-MM-DD
 *   ## <repo>  _(finder: agent)_
 *   ### [SEVERITY] <title>
 *   - file: `<path>`:<line>
 *   - why: <one line>
 *   - suggested fix: <one line>
 *
 * Repos with "- no findings" or "- scan error: ..." contribute nothing.
 */
export function parseSelfHealReport(markdown: string): SelfHealFinding[] {
	const findings: SelfHealFinding[] = [];
	const dateMatch = markdown.match(/^# self-heal report (\d{4}-\d{2}-\d{2})/m);
	const reportDate = dateMatch ? dateMatch[1] : undefined;

	let current: Partial<SelfHealFinding> | null = null;
	const flush = () => {
		if (current?.severity && current.title && current.file && current.why && current.suggestedFix) {
			findings.push({
				severity: current.severity,
				title: current.title,
				file: current.file,
				line: current.line ?? "",
				why: current.why,
				suggestedFix: current.suggestedFix,
				reportDate,
			});
		}
		current = null;
	};

	for (const raw of markdown.split("\n")) {
		const line = raw.trim();
		const heading = line.match(/^### \[([A-Z]+)\] (.+)$/);
		if (heading) {
			flush();
			current = { severity: heading[1].toLowerCase(), title: heading[2].trim() };
			continue;
		}
		if (!current) continue;
		const file = line.match(/^- file: `([^`]+)`:?(.*)$/);
		if (file) {
			current.file = file[1];
			current.line = file[2].trim();
			continue;
		}
		const why = line.match(/^- why: (.+)$/);
		if (why) {
			current.why = why[1];
			continue;
		}
		const fix = line.match(/^- suggested fix: (.+)$/);
		if (fix) {
			current.suggestedFix = fix[1];
			continue;
		}
		if (line.startsWith("## ") || line.startsWith("# ")) flush();
	}
	flush();
	return findings;
}

function liveDemoPrompt(entry: LiveDemoEntry): string {
	return `Live demo check "${entry.check}" on surface "${entry.surface}" is failing. Diagnose the cause and fix it.`;
}

/**
 * Map LiveDemo ledger entries to labeled examples.
 *
 *   - status "fail" with a recorded cause -> negative: a real diagnosis with
 *     no fix applied.
 *   - status "fixed" with BOTH a cause and a fix -> positive: the full
 *     diagnose-then-fix lesson. Auto-closed entries ("re-demo passed") carry
 *     no cause and teach nothing, so they are skipped - a lesson needs both
 *     the diagnosis and the remedy.
 */
export function liveDemoToLessons(entries: LiveDemoEntry[]): LessonExample[] {
	const lessons: LessonExample[] = [];
	for (const entry of entries) {
		const occurredAt = typeof entry.ts === "number" ? entry.ts * 1000 : Date.now();
		const ref = `livedemo:${entry.surface}:${entry.check}`;
		const cause = entry.cause?.trim();
		const fix = entry.fix?.trim();

		if (entry.status === "fail" && cause) {
			lessons.push({
				source: "livedemo",
				polarity: "negative",
				ref,
				prompt: liveDemoPrompt(entry),
				response: `Cause: ${cause}`,
				score: 0,
				occurredAt,
			});
		} else if (entry.status === "fixed" && cause && fix) {
			lessons.push({
				source: "livedemo",
				polarity: "positive",
				ref,
				prompt: liveDemoPrompt(entry),
				response: `Cause: ${cause}\nFix: ${fix}`,
				score: 1,
				occurredAt,
			});
		}
	}
	return lessons;
}

function selfHealPrompt(finding: SelfHealFinding): string {
	const at = finding.line ? `${finding.file}:${finding.line}` : finding.file;
	return `Self-heal audit flagged a ${finding.severity} defect at ${at}: ${finding.title}. Assess the defect and propose the fix.`;
}

/**
 * Map selfheal findings to labeled examples. Each finding yields a genuine
 * contrast: the shipped defect (negative, the "why") vs the same diagnosis
 * completed with the auditor's fix (positive).
 */
export function selfHealToLessons(findings: SelfHealFinding[]): LessonExample[] {
	const lessons: LessonExample[] = [];
	for (const finding of findings) {
		const occurredAt = finding.reportDate ? Date.parse(finding.reportDate) : Date.now();
		const ref = `selfheal:${finding.file}:${finding.line}`;
		const prompt = selfHealPrompt(finding);
		lessons.push({
			source: "selfheal",
			polarity: "negative",
			ref,
			prompt,
			response: `Defect: ${finding.why}`,
			score: 0,
			occurredAt,
		});
		lessons.push({
			source: "selfheal",
			polarity: "positive",
			ref,
			prompt,
			response: `Defect: ${finding.why}\nFix: ${finding.suggestedFix}`,
			score: 1,
			occurredAt,
		});
	}
	return lessons;
}

/**
 * Emit GRPO preference pairs where a ref carries BOTH a negative and a
 * positive: chosen is the recorded fix, rejected is the recorded failure.
 * Refs with only one polarity are skipped - no fabricated preference.
 */
export function lessonsToGrpoPairs(lessons: LessonExample[]): GrpoPair[] {
	const byRef = new Map<string, LessonExample[]>();
	for (const lesson of lessons) {
		const arr = byRef.get(lesson.ref) ?? [];
		arr.push(lesson);
		byRef.set(lesson.ref, arr);
	}

	const out: GrpoPair[] = [];
	for (const [ref, group] of byRef) {
		const positive = group.find((l) => l.polarity === "positive");
		const negative = group.find((l) => l.polarity === "negative");
		if (!positive || !negative) continue;
		if (positive.response === negative.response) continue;
		out.push({
			prompt: positive.prompt,
			chosen: positive.response,
			rejected: negative.response,
			chosen_score: 1,
			rejected_score: 0,
			session_id: ref,
			collected_at: new Date(Math.max(positive.occurredAt, negative.occurredAt)).toISOString(),
		});
	}
	return out;
}

/** Stable dedupe key so nightly re-reads of the same sources append nothing new. */
function lessonKey(lesson: LessonExample): string {
	return `${lesson.source}|${lesson.ref}|${lesson.polarity}|${lesson.response}`;
}

export class LessonCollector {
	private lessonsPath: string;
	private trainingDir: string;
	private optedIn: boolean;
	private liveDemoLedgerPath: string;
	private selfHealReportsDir: string;

	constructor(projectRoot: string = process.cwd(), enabled = false, sources: LessonSources = {}) {
		this.trainingDir = resolve(projectRoot, ".8gent", "kernel", "training");
		this.lessonsPath = join(this.trainingDir, "lessons.jsonl");
		this.optedIn = enabled;
		this.liveDemoLedgerPath =
			sources.liveDemoLedgerPath ?? join(homedir(), ".8gent", "livedemo-ledger.jsonl");
		this.selfHealReportsDir =
			sources.selfHealReportsDir ?? join(homedir(), ".8gent", "self-heal", "reports");
	}

	/** Whether lesson feeds are opted in. */
	get enabled(): boolean {
		return this.optedIn;
	}

	/**
	 * Read both sources, scrub, dedupe against what is already on disk, and
	 * append the new lessons to .8gent/kernel/training/lessons.jsonl.
	 * No-op (all zeros) unless opted in.
	 */
	collect(): CollectResult {
		const result: CollectResult = { collected: 0, duplicates: 0, dropped: 0 };
		if (!this.optedIn) return result;

		const raw: LessonExample[] = [];
		if (existsSync(this.liveDemoLedgerPath)) {
			raw.push(
				...liveDemoToLessons(parseLiveDemoLedger(readFileSync(this.liveDemoLedgerPath, "utf-8"))),
			);
		}
		if (existsSync(this.selfHealReportsDir)) {
			for (const name of readdirSync(this.selfHealReportsDir).sort()) {
				if (!name.endsWith(".md")) continue;
				raw.push(
					...selfHealToLessons(
						parseSelfHealReport(readFileSync(join(this.selfHealReportsDir, name), "utf-8")),
					),
				);
			}
		}

		const seen = new Set(this.readLessons().map(lessonKey));
		const lines: string[] = [];
		for (const lesson of raw) {
			// Scrub BEFORE keying/persisting; drop this lesson (and only this
			// lesson) if anything secret- or PII-shaped survives.
			const prompt = scrubField(lesson.prompt);
			const response = scrubField(lesson.response);
			const ref = scrubField(lesson.ref);
			if (prompt === null || response === null || ref === null) {
				result.dropped++;
				continue;
			}
			const scrubbed: LessonExample = { ...lesson, prompt, response, ref };
			const key = lessonKey(scrubbed);
			if (seen.has(key)) {
				result.duplicates++;
				continue;
			}
			seen.add(key);
			lines.push(JSON.stringify(scrubbed));
			result.collected++;
		}

		if (lines.length > 0) {
			this.ensureDir();
			appendFileSync(this.lessonsPath, `${lines.join("\n")}\n`);
		}
		return result;
	}

	/** Read all persisted lessons back from local storage. */
	readLessons(): LessonExample[] {
		if (!existsSync(this.lessonsPath)) return [];
		return readFileSync(this.lessonsPath, "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				try {
					return JSON.parse(line) as LessonExample;
				} catch {
					return null;
				}
			})
			.filter(Boolean) as LessonExample[];
	}

	/** GRPO preference pairs from the persisted lessons (real contrasts only). */
	toGrpoPairs(): GrpoPair[] {
		return lessonsToGrpoPairs(this.readLessons());
	}

	private ensureDir(): void {
		if (!existsSync(this.trainingDir)) {
			mkdirSync(this.trainingDir, { recursive: true });
		}
	}
}
