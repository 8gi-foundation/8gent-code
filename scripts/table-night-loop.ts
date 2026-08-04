/**
 * table-night-loop.ts - the 8gent Table OVERNIGHT SELF-IMPROVEMENT LOOP.
 *
 * Builds directly on the proven table-live-mesh.ts harness: same TableStore +
 * AgentPool ("table" pool channel, __table__ read-only scope) + officer roster
 * + createClient({runtime, model, baseUrl}) + hash-chained ledger. Local models
 * only; nothing egresses off-box; officers author and grade TEXT only and never
 * touch the repo (agentScope "__table__").
 *
 * Each ROUND is one real, daily-equivalent task (see scripts/night-tasks.ts):
 *   1. Pick a task deterministically by round index (round % NIGHT_TASKS.length).
 *      The task bank is interleaved by domain, so rounds rotate across all eight.
 *   2. Pick the DOER: the officer who owns the task's domain (fallback: rotate).
 *   3. Pick the GRADER: a DIFFERENT officer on a DIFFERENT backend (a different
 *      provider:model pair, so a genuinely different model does the grading).
 *   4. DOER runs the task on its local backend and posts the answer, signed,
 *      into the #nightshift Table channel.
 *   5. GRADER scores the answer 1-10 against the task's rubricFocus + the 8GI
 *      principles (evidence not hype, sovereignty, concision) and gives ONE
 *      concrete improvement, posted signed into the channel.
 *   6. Append a JSONL record to ~/.8gent/table-night/rounds.jsonl.
 *
 * Tolerant by design: any backend error / empty reply / timeout is recorded as
 * ok:false with the reason and the loop continues. ornith is a reasoning model
 * and is given a token budget (the reasoning-model quirk from the mesh harness).
 *
 * PERSISTENT corpus: the DB, ledger, and keys live under ~/.8gent/table-night/
 * (never a temp dir), so the channel and the graded-rounds corpus accrue across
 * nights.
 *
 * Run:
 *   bun run scripts/table-night-loop.ts --rounds 8
 *   bun run scripts/table-night-loop.ts --rounds 16 --channel nightshift
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentPool } from "/Users/jamesspalding/8gent-code/packages/daemon/agent-pool.ts";
import { createClient } from "/Users/jamesspalding/8gent-code/packages/eight/clients/index.ts";
import { LOCAL_PROVIDERS } from "/Users/jamesspalding/8gent-code/packages/eight/registry.ts";
import type { Message as LLMMessage } from "/Users/jamesspalding/8gent-code/packages/eight/types.ts";
import { Ledger } from "/Users/jamesspalding/8gent-code/packages/goal/ledger.ts";
import {
	OFFICERS,
	type Officer,
	TableStore,
	canonicalMessage,
	listOfficers,
	mintIdentity,
	scanMentions,
	signMessage,
	verifyMessage,
} from "/Users/jamesspalding/8gent-code/packages/table/index.ts";
import {
	DOMAIN_OFFICER,
	NIGHT_TASKS,
	type NightTask,
} from "/Users/jamesspalding/8gent-code/scripts/night-tasks.ts";

// ── Persistent home (NOT a temp dir) so the corpus accrues across nights ────
const NIGHT_HOME = path.join(os.homedir(), ".8gent", "table-night");
const DB_PATH = path.join(NIGHT_HOME, "table.db");
const LEDGER_BASE = NIGHT_HOME; // Ledger.open makes <base>/<runId>/ledger.jsonl
const LEDGER_RUN_ID = "ledger";
const KEY_ROOT = path.join(NIGHT_HOME, "keys");
const ROUNDS_JSONL = path.join(NIGHT_HOME, "rounds.jsonl");
// The HMAC key is persisted alongside the ledger so verify() holds across
// nights. Without a stable key the reopened chain would fail signature checks.
const HMAC_KEY_PATH = path.join(NIGHT_HOME, "state-hmac.key");

const HUMAN = "human:james";

// Per-provider wall-clock budget. Reasoning models are slower; a timeout is
// recorded as a failed round, never a crash.
const TIMEOUT_MS: Record<Officer["provider"], number> = {
	apfel: 90_000,
	ollama: 90_000,
	lmstudio: 240_000,
};

// ── CLI ─────────────────────────────────────────────────────────────────────
interface Args {
	rounds: number;
	channel: string;
}

function parseArgs(argv: string[]): Args {
	let rounds = 1;
	let channel = "nightshift";
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--rounds") {
			const n = Number.parseInt(argv[++i] ?? "", 10);
			if (Number.isFinite(n) && n >= 0) rounds = n;
		} else if (a.startsWith("--rounds=")) {
			const n = Number.parseInt(a.slice("--rounds=".length), 10);
			if (Number.isFinite(n) && n >= 0) rounds = n;
		} else if (a === "--channel") {
			channel = (argv[++i] ?? channel).trim() || channel;
		} else if (a.startsWith("--channel=")) {
			channel = a.slice("--channel=".length).trim() || channel;
		}
	}
	return { rounds, channel };
}

// ── Backend identity ─────────────────────────────────────────────────────────
/**
 * A backend key is the provider:model pair. Two officers on the same lmstudio
 * server but different models (ornith vs gemma) are DIFFERENT backends, so a
 * grader with a different key is genuinely a different model checking the work.
 */
function backendKey(o: Officer): string {
	return `${o.provider}:${o.model}`;
}

function isReasoningModel(model: string): boolean {
	return /ornith/i.test(model);
}

// ── Persistent HMAC key ──────────────────────────────────────────────────────
function loadOrCreateHmacKey(): Buffer {
	try {
		if (fs.existsSync(HMAC_KEY_PATH)) {
			const hex = fs.readFileSync(HMAC_KEY_PATH, "utf8").trim();
			if (hex.length >= 32) return Buffer.from(hex, "hex");
		}
	} catch {
		// fall through and mint a fresh one
	}
	const key = randomBytes(32);
	fs.mkdirSync(path.dirname(HMAC_KEY_PATH), { recursive: true });
	fs.writeFileSync(HMAC_KEY_PATH, key.toString("hex"), { mode: 0o600 });
	try {
		fs.chmodSync(HMAC_KEY_PATH, 0o600);
	} catch {
		// best-effort
	}
	return key;
}

// ── Timeout wrapper ──────────────────────────────────────────────────────────
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		p,
		new Promise<T>((_, reject) =>
			setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms),
		),
	]);
}

/**
 * Budgeted OpenAI-compatible chat against an lmstudio baseUrl. Sets max_tokens
 * (which the shipped LMStudioClient does not) and reads `content`, falling back
 * to `reasoning_content` only when content is genuinely empty - the reasoning
 * model quirk carried over from table-live-mesh.ts.
 */
async function lmStudioBudgetedChat(
	baseUrl: string,
	model: string,
	messages: LLMMessage[],
	maxTokens: number,
): Promise<{ text: string; usedReasoningField: boolean }> {
	const res = await fetch(`${baseUrl}/v1/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			messages: messages.map((m) => ({ role: m.role, content: m.content })),
			max_tokens: maxTokens,
			temperature: 0.4,
			stream: false,
		}),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`lmstudio ${res.status} ${res.statusText} - ${body.slice(0, 160)}`);
	}
	const data = (await res.json()) as {
		choices?: { message?: { content?: string; reasoning_content?: string } }[];
	};
	const msg = data.choices?.[0]?.message ?? {};
	const content = (msg.content ?? "").trim();
	const reasoning = (msg.reasoning_content ?? "").trim();
	return { text: content || reasoning, usedReasoningField: !content && reasoning.length > 0 };
}

/**
 * Produce a reply on the officer's assigned local backend using the exact
 * createClient() factory the AgentPool session's agent uses, except the
 * reasoning model routes through the budgeted call (the shipped client cannot
 * set max_tokens).
 */
async function inferOnBackend(officer: Officer, messages: LLMMessage[]): Promise<string> {
	if (officer.provider === "lmstudio" && isReasoningModel(officer.model)) {
		const r = await lmStudioBudgetedChat(officer.baseUrl, officer.model, messages, 4000);
		return r.text.trim();
	}
	const client = createClient({
		runtime: officer.provider,
		model: officer.model,
		baseUrl: officer.baseUrl,
	});
	const resp = await client.chat(messages);
	return (resp.message.content ?? "").trim();
}

// ── Officer selection (deterministic, no Math.random) ────────────────────────
function pickDoer(task: NightTask, round: number): Officer {
	const code = DOMAIN_OFFICER[task.domain];
	const officer = code ? OFFICERS[code] : undefined;
	if (officer) return officer;
	// Fallback: rotate through the roster by round index.
	const all = listOfficers();
	return all[round % all.length];
}

/**
 * Grader: a DIFFERENT officer on a DIFFERENT backend than the doer. Candidates
 * are all officers whose backendKey differs from the doer's (which already
 * excludes the doer). Chosen deterministically by round index.
 */
function pickGrader(doer: Officer, round: number): Officer {
	const doerKey = backendKey(doer);
	const candidates = listOfficers().filter((o) => backendKey(o) !== doerKey);
	// candidates is never empty: four distinct backends exist.
	return candidates[round % candidates.length];
}

// ── Grader output parsing ────────────────────────────────────────────────────
interface GraderParse {
	score: number | null;
	critique: string;
	improvement: string;
}

function parseGrader(raw: string): GraderParse {
	const scoreMatch = raw.match(/SCORE:\s*(\d{1,2})/i);
	let score: number | null = null;
	if (scoreMatch) {
		const n = Number.parseInt(scoreMatch[1], 10);
		if (Number.isFinite(n)) score = Math.min(10, Math.max(1, n));
	}
	const critMatch = raw.match(/CRITIQUE:\s*([\s\S]*?)(?:\n\s*IMPROVEMENT:|$)/i);
	const impMatch = raw.match(/IMPROVEMENT:\s*([\s\S]*)$/i);
	const critique = (critMatch?.[1] ?? "").trim() || raw.trim();
	const improvement = (impMatch?.[1] ?? "").trim();
	return { score, critique, improvement };
}

function buildGraderPrompt(task: NightTask, doer: Officer, answer: string): string {
	const clipped = answer.length > 1500 ? `${answer.slice(0, 1500)} [...]` : answer;
	return (
		"You are grading another officer's answer to an internal task. Be a tough but fair judge.\n\n" +
		`TASK (domain: ${task.domain}):\n${task.prompt}\n\n` +
		`RUBRIC FOCUS: ${task.rubricFocus}\n` +
		"Also weigh 8GI principles: evidence over hype, sovereignty (local-first, no cloud dependence), and concision. No em dashes.\n\n" +
		`OFFICER ${doer.code} (${doer.name}) ANSWERED:\n"""\n${clipped}\n"""\n\n` +
		"Score the answer 1-10 against the rubric focus and the 8GI principles, then give ONE concrete improvement. " +
		"Respond in EXACTLY this format and nothing else:\n" +
		"SCORE: <integer 1-10>/10\n" +
		"CRITIQUE: <one sentence, what is strong or weak>\n" +
		"IMPROVEMENT: <one concrete, actionable change>"
	);
}

// ── Signed post helper ───────────────────────────────────────────────────────
function postSigned(
	store: TableStore,
	keyDir: { root: string },
	channelId: string,
	authorId: string,
	content: string,
	replyTo?: string,
): string {
	const createdAt = Date.now();
	const canon = canonicalMessage({ channelId, authorId, content, replyTo, createdAt });
	const sig = signMessage(authorId, canon, keyDir);
	if (!verifyMessage(authorId, canon, sig, keyDir)) {
		throw new Error(`signature failed self-verification for ${authorId}`);
	}
	const msg = store.postMessage({ channelId, authorId, content, replyTo, sig });
	return msg.id;
}

// ── Find-or-create channel + membership (persists across nights) ─────────────
function ensureChannel(
	store: TableStore,
	keyDir: { root: string },
	name: string,
): string {
	const existing = store.listChannels().find((c) => c.name === name);
	if (existing) return existing.id;
	const created = store.createChannel({
		name,
		type: "stream",
		visibility: "private",
		topic: "8GI officer night shift - overnight self-improvement loop",
		createdBy: HUMAN,
	});
	return created.id;
}

function ensureMember(
	store: TableStore,
	channelId: string,
	agentId: string,
): void {
	if (store.isMember(channelId, agentId)) return;
	store.addMember({ channelId, participantId: agentId, role: "bot", addedBy: HUMAN });
}

// ── Per-round record ─────────────────────────────────────────────────────────
interface RoundRecord {
	ts_round_index: number;
	ts: number;
	task_id: string;
	domain: string;
	doer_code: string;
	doer_model: string;
	grader_code: string;
	grader_model: string;
	score: number | null;
	attempt_first200: string;
	critique_first200: string;
	lesson_first200: string;
	ok: boolean;
	error?: string;
}

function first200(s: string): string {
	return s.replace(/\s+/g, " ").trim().slice(0, 200);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
	const { rounds, channel } = parseArgs(process.argv.slice(2));

	fs.mkdirSync(NIGHT_HOME, { recursive: true });
	const keyDir = { root: KEY_ROOT };

	console.log(`\n=== 8gent Table OVERNIGHT SELF-IMPROVEMENT LOOP ===`);
	console.log(`home     : ${NIGHT_HOME}`);
	console.log(`channel  : #${channel}`);
	console.log(`rounds   : ${rounds}`);
	console.log(`backends : apfel :11435 | lmstudio :1234 | ollama :11434 (all local)\n`);

	const ledger = Ledger.open({
		runId: LEDGER_RUN_ID,
		baseDir: LEDGER_BASE,
		key: loadOrCreateHmacKey(),
	});
	const store = new TableStore({ dbPath: DB_PATH, ledger });

	// Pool defaults to a safe local runtime; working dir is the night home so no
	// session can write into the repo. Officers run read-only (__table__ scope).
	const pool = new AgentPool({
		workingDirectory: NIGHT_HOME,
		model: "llama3.2:3b",
		runtime: "ollama",
	});

	mintIdentity(HUMAN, keyDir);
	const channelId = ensureChannel(store, keyDir, channel);
	console.log(`#${channel} ready: ${channelId} (owner ${HUMAN})\n`);

	const records: RoundRecord[] = [];

	for (let round = 0; round < rounds; round++) {
		const task = NIGHT_TASKS[round % NIGHT_TASKS.length];
		const doer = pickDoer(task, round);
		const grader = pickGrader(doer, round);

		const rec: RoundRecord = {
			ts_round_index: round,
			ts: Date.now(),
			task_id: task.id,
			domain: task.domain,
			doer_code: doer.code,
			doer_model: doer.model,
			grader_code: grader.code,
			grader_model: grader.model,
			score: null,
			attempt_first200: "",
			critique_first200: "",
			lesson_first200: "",
			ok: false,
		};

		const doerSid = `table:${channel}:doer:${doer.code}:${round}`;
		const graderSid = `table:${channel}:grader:${grader.code}:${round}`;

		console.log(
			`--- round ${round} | ${task.domain} (${task.id}) | doer ${doer.code} ${doer.name} -> grader ${grader.code} ${grader.name} ---`,
		);

		try {
			// Roster invariant: never pin an officer to a non-local provider.
			if (!LOCAL_PROVIDERS.has(doer.provider)) {
				throw new Error(`roster invariant broken: doer ${doer.provider} is not LOCAL`);
			}
			if (!LOCAL_PROVIDERS.has(grader.provider)) {
				throw new Error(`roster invariant broken: grader ${grader.provider} is not LOCAL`);
			}

			// Officers are members of the channel (idempotent across nights).
			mintIdentity(`agent:${doer.code}`, keyDir);
			mintIdentity(`agent:${grader.code}`, keyDir);
			ensureMember(store, channelId, `agent:${doer.code}`);
			ensureMember(store, channelId, `agent:${grader.code}`);

			// Human posts the task, @mentioning the doer, signed.
			const humanContent = `@${doer.code} ${task.prompt}`;
			if (!scanMentions(humanContent).includes(doer.code)) {
				throw new Error(`mention scan failed to target ${doer.code}`);
			}
			const humanMsgId = postSigned(store, keyDir, channelId, HUMAN, humanContent);

			// DOER session with the officer's backend override, read-only scope.
			pool.createSession(doerSid, "table", {
				runtime: doer.provider,
				model: doer.model,
				baseUrl: doer.baseUrl,
				systemPrompt: doer.systemPrompt,
				agentScope: "__table__",
			});
			if (!pool.hasSession(doerSid)) throw new Error("doer pool session not created");

			const doerMessages: LLMMessage[] = [
				{ role: "system", content: doer.systemPrompt },
				{ role: "user", content: task.prompt },
			];
			const answer = (
				await withTimeout(
					inferOnBackend(doer, doerMessages),
					TIMEOUT_MS[doer.provider],
					`${doer.code}/${doer.provider}`,
				)
			).trim();
			if (answer.length === 0) throw new Error("doer returned an empty reply");

			// Post the doer's answer, signed, as a reply to the task.
			const answerMsgId = postSigned(
				store,
				keyDir,
				channelId,
				`agent:${doer.code}`,
				answer,
				humanMsgId,
			);
			rec.attempt_first200 = first200(answer);

			// GRADER session on a DIFFERENT backend, read-only scope.
			pool.createSession(graderSid, "table", {
				runtime: grader.provider,
				model: grader.model,
				baseUrl: grader.baseUrl,
				systemPrompt: grader.systemPrompt,
				agentScope: "__table__",
			});
			if (!pool.hasSession(graderSid)) throw new Error("grader pool session not created");

			const graderPrompt = buildGraderPrompt(task, doer, answer);
			const graderMessages: LLMMessage[] = [
				{ role: "system", content: grader.systemPrompt },
				{ role: "user", content: graderPrompt },
			];
			const graderRaw = (
				await withTimeout(
					inferOnBackend(grader, graderMessages),
					TIMEOUT_MS[grader.provider],
					`${grader.code}/${grader.provider}`,
				)
			).trim();
			if (graderRaw.length === 0) throw new Error("grader returned an empty reply");

			const parsed = parseGrader(graderRaw);
			rec.score = parsed.score;
			rec.critique_first200 = first200(parsed.critique);
			rec.lesson_first200 = first200(parsed.improvement || parsed.critique);

			// Post the grader's critique, signed, as a reply to the doer's answer.
			postSigned(store, keyDir, channelId, `agent:${grader.code}`, graderRaw, answerMsgId);

			rec.ok = true;
			console.log(
				`    score ${rec.score ?? "?"}/10 | attempt: ${rec.attempt_first200.slice(0, 80)}`,
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			rec.ok = false;
			rec.error = msg;
			console.log(`    FAILED: ${msg}`);
		} finally {
			pool.destroySession(doerSid);
			pool.destroySession(graderSid);
		}

		// Append the round record to the persistent corpus (crash-safe: one line).
		fs.appendFileSync(ROUNDS_JSONL, `${JSON.stringify(rec)}\n`);
		records.push(rec);
	}

	// ── Summary ─────────────────────────────────────────────────────────────
	console.log(`\n=================== NIGHT SUMMARY ===================\n`);
	console.log(`round | domain        | doer -> grader        | score`);
	console.log(`------+---------------+-----------------------+------`);
	for (const r of records) {
		const dom = r.domain.padEnd(13);
		const pair = `${r.doer_code} -> ${r.grader_code}`.padEnd(21);
		const score = r.ok ? (r.score ?? "?").toString() : "FAIL";
		console.log(`${String(r.ts_round_index).padStart(5)} | ${dom} | ${pair} | ${score}`);
	}

	const scored = records.filter((r) => r.ok && typeof r.score === "number") as (RoundRecord & {
		score: number;
	})[];
	const avg =
		scored.length > 0 ? scored.reduce((s, r) => s + r.score, 0) / scored.length : Number.NaN;
	const okCount = records.filter((r) => r.ok).length;

	console.log(
		`\nrounds ok: ${okCount}/${records.length}  |  scored: ${scored.length}  |  average score: ${
			scored.length > 0 ? avg.toFixed(2) : "n/a"
		}`,
	);

	// The three lowest-scoring rounds - where the system most needs improvement.
	const lowest = [...scored].sort((a, b) => a.score - b.score).slice(0, 3);
	if (lowest.length > 0) {
		console.log(`\nWhere to improve first (3 lowest scores):`);
		for (const r of lowest) {
			console.log(
				`  [${r.score}/10] ${r.domain} ${r.task_id} (${r.doer_code} graded by ${r.grader_code})`,
			);
			if (r.lesson_first200) console.log(`        lesson: ${r.lesson_first200}`);
		}
	}

	// ── Ledger verify ────────────────────────────────────────────────────────
	const vr = store.getLedger().verify();
	console.log(
		`\nledger.verify() -> ${JSON.stringify({ ok: vr.ok, count: vr.count })}  (${ROUNDS_JSONL})`,
	);
	console.log(
		`\nRESULT: ${okCount}/${records.length} rounds completed | ledger ${
			vr.ok ? "OK" : "BROKEN"
		} | corpus at ${ROUNDS_JSONL}\n`,
	);

	store.close();
	// AgentPool holds a cleanup interval; exit deterministically.
	process.exit(vr.ok ? 0 : 1);
}

main().catch((err) => {
	console.error("night loop crashed:", err);
	process.exit(2);
});
