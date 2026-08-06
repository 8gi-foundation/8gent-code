/**
 * table-live-mesh.ts — LIVE multi-backend proof harness for @8gent/table.
 *
 * Proves the 8gent Table works across ALL FOUR local (sovereign, on-box)
 * inference backends WITHOUT the daemon WebSocket: it drives the STORE +
 * AgentPool + officer roster directly, so the run is deterministic and the
 * failure surface is wiring, not transport.
 *
 * Backends exercised (one officer each, all local, no cloud egress):
 *   - apfel    (Apple Foundation, :11435/v1)  -> 8EO AI James
 *   - lmstudio (gemma-4-12b-coder, :1234)     -> 8TO Rishi
 *   - lmstudio (ornith-1.0-9b, reasoning)     -> 8SO Karen   [budget-tokens quirk]
 *   - ollama   (llama3.2:3b, :11434)          -> 8CO Luis
 *
 * Per officer:
 *   1. Create a REAL AgentPool "table" session with the officer's roster
 *      override (runtime + model + baseUrl + systemPrompt, agentScope
 *      "__table__"). The pool's F4 gate is proven to KEEP the local runtime
 *      (no downgrade to ollama) by parsing the pool's created-session log.
 *   2. Post a signed human @mention into #boardroom (store + ledger).
 *   3. Produce the reply on the officer's assigned backend via the SAME client
 *      factory the session's agent uses — createClient({runtime, model,
 *      baseUrl}) — so the reply genuinely comes from that officer's endpoint.
 *      (The reasoning model needs a token budget + reasoning_content read that
 *      the shipped LMStudioClient does not set, so that one path uses a
 *      harness-level budgeted call to the identical baseUrl; this is flagged.)
 *   4. Post the reply back into the channel, signed by the officer key and
 *      appended to the hash-chained ledger.
 *
 * Tolerant by design: a backend that errors/empties/times-out is recorded as
 * FAILED with the reason and does NOT crash the run — the honest per-backend
 * result table is the point.
 *
 * Run:  bun run scripts/table-live-mesh.ts
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
	mintIdentity,
	scanMentions,
	signMessage,
	verifyMessage,
} from "/Users/jamesspalding/8gent-code/packages/table/index.ts";

// ── The four officers, one per live local backend ──────────────────────────
const SELECTED_CODES = ["8EO", "8TO", "8SO", "8CO"] as const;

// Per-officer wall-clock budget. Reasoning models are slower, so give lmstudio
// more room. A timeout is recorded as FAILED, never a crash.
const TIMEOUT_MS: Record<Officer["provider"], number> = {
	apfel: 90_000,
	ollama: 90_000,
	lmstudio: 240_000,
};

// Reasoning models emit their answer into `reasoning_content` and need a high
// `max_tokens` or `content` comes back empty. Detected by model id.
function isReasoningModel(model: string): boolean {
	return /ornith/i.test(model);
}

interface OfficerResult {
	code: string;
	name: string;
	provider: string;
	model: string;
	endpoint: string;
	f4: string; // "KEPT(local)" | "DOWNGRADED->x" | "?"
	status: "OK" | "FAILED";
	reply: string;
	replyFull: string;
	note: string;
	ledgerRecorded: boolean;
	ms: number;
}

function timeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		p,
		new Promise<T>((_, reject) =>
			setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms),
		),
	]);
}

/**
 * Budgeted OpenAI-compatible chat against a specific lmstudio baseUrl. Sets
 * max_tokens (which the shipped LMStudioClient does not) and reads
 * `content` then falls back to `reasoning_content` — the reasoning-model quirk.
 * Hits the SAME endpoint the officer's createClient() client would.
 */
async function lmStudioBudgetedChat(
	baseUrl: string,
	model: string,
	messages: LLMMessage[],
	maxTokens: number,
): Promise<{ text: string; usedReasoningField: boolean; serverModel: string }> {
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
		model?: string;
		choices?: { message?: { content?: string; reasoning_content?: string } }[];
	};
	const msg = data.choices?.[0]?.message ?? {};
	const content = (msg.content ?? "").trim();
	const reasoning = (msg.reasoning_content ?? "").trim();
	return {
		text: content || reasoning,
		usedReasoningField: !content && reasoning.length > 0,
		serverModel: data.model ?? model,
	};
}

/**
 * Produce a reply on the officer's assigned local backend. Uses the exact
 * createClient() factory the AgentPool session's agent uses (so baseUrl/model
 * routing is the real wiring), except the reasoning model routes through the
 * budgeted call above because the shipped client cannot set max_tokens.
 */
async function inferOnBackend(
	officer: Officer,
	messages: LLMMessage[],
): Promise<{ text: string; note: string }> {
	if (officer.provider === "lmstudio" && isReasoningModel(officer.model)) {
		// Reasoning models spend tokens on a hidden thinking trace FIRST, then
		// emit the final answer into `content`. Too small a budget and it runs
		// out mid-thought and `content` stays empty. Budget generously so the
		// final answer lands in `content`; only fall back to the raw
		// reasoning_content trace if `content` is genuinely empty.
		const r = await lmStudioBudgetedChat(officer.baseUrl, officer.model, messages, 4000);
		const note = r.usedReasoningField
			? "reasoning-model: content empty even at budget 4000, fell back to reasoning_content trace"
			: "reasoning-model: budget 4000, answer read from content field";
		return { text: r.text, note };
	}

	// The identical client the pool session's agent builds from its AgentConfig.
	const client = createClient({
		runtime: officer.provider,
		model: officer.model,
		baseUrl: officer.baseUrl,
	});
	const resp = await client.chat(messages);
	return {
		text: (resp.message.content ?? "").trim(),
		note: `createClient(${officer.provider}) -> ${client.constructor.name}`,
	};
}

async function main(): Promise<void> {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "table-mesh-"));
	const keyDir = { root: path.join(tmp, "keys") };
	const ledgerBase = path.join(tmp, "ledger");
	const runId = "table-live-mesh";

	console.log(`\n=== 8gent Table LIVE local-mesh proof (tmp=${tmp}) ===`);
	console.log(`local backends: apfel :11435 | lmstudio :1234 | ollama :11434 (no cloud)\n`);

	const ledger = Ledger.open({ runId, baseDir: ledgerBase, key: randomBytes(32) });
	const store = new TableStore({ dbPath: ":memory:", ledger });

	// AgentPool: default to a safe local runtime; working dir is the temp dir so
	// nothing is written into the repo. The pool builds a real Agent per session.
	const pool = new AgentPool({
		workingDirectory: tmp,
		model: "llama3.2:3b",
		runtime: "ollama",
	});

	const HUMAN = "human:james";
	mintIdentity(HUMAN, keyDir);

	// #boardroom — creator (human) auto-seeded as owner.
	const boardroom = store.createChannel({
		name: "boardroom",
		type: "stream",
		visibility: "private",
		topic: "8GI officer boardroom - local mesh proof",
		createdBy: HUMAN,
	});
	console.log(`#boardroom created: ${boardroom.id} (owner ${HUMAN})\n`);

	const results: OfficerResult[] = [];
	let humanPosts = 0;

	for (const code of SELECTED_CODES) {
		const officer = OFFICERS[code];
		const agentId = `agent:${officer.code}`;
		const sid = `table:boardroom:${officer.code}`;
		const started = Date.now();
		let f4 = "?";
		let ledgerRecorded = false;
		let status: OfficerResult["status"] = "FAILED";
		let replyFull = "";
		let note = "";

		try {
			// Sanity: roster must never pin an officer to a non-local provider.
			if (!LOCAL_PROVIDERS.has(officer.provider)) {
				throw new Error(`roster invariant broken: ${officer.provider} is not a LOCAL provider`);
			}

			// 1. REAL AgentPool session with the officer's backend override.
			//    Capture the pool's created-session log to prove the F4 gate KEPT
			//    the local runtime (a cloud runtime would be downgraded to ollama).
			const captured: string[] = [];
			const origLog = console.log;
			console.log = (...args: unknown[]) => {
				captured.push(args.map(String).join(" "));
			};
			try {
				pool.createSession(sid, "table", {
					runtime: officer.provider,
					model: officer.model,
					baseUrl: officer.baseUrl,
					systemPrompt: officer.systemPrompt,
					agentScope: "__table__",
				});
			} finally {
				console.log = origLog;
			}
			const createdLine = captured.find((l) => l.includes(`created session ${sid}`)) ?? "";
			const runtimeMatch = createdLine.match(/runtime=([\w-]+)/);
			const resolvedRuntime = runtimeMatch?.[1] ?? "?";
			f4 =
				resolvedRuntime === officer.provider
					? "KEPT(local)"
					: `DOWNGRADED->${resolvedRuntime}`;
			if (!pool.hasSession(sid)) throw new Error("pool session was not created");

			// 2. Officer joins the channel; signed human @mention posted.
			mintIdentity(agentId, keyDir);
			store.addMember({
				channelId: boardroom.id,
				participantId: agentId,
				role: "bot",
				addedBy: HUMAN,
			});

			const humanContent = `@${officer.code} in one or two sentences: is a fully local, no-cloud agent table a real security win, and what is the one risk you would still watch? Answer as ${officer.name} (${officer.role}).`;
			if (!scanMentions(humanContent).includes(officer.code)) {
				throw new Error(`mention scan failed to target ${officer.code}`);
			}
			const humanCreatedAt = Date.now();
			const humanCanon = canonicalMessage({
				channelId: boardroom.id,
				authorId: HUMAN,
				content: humanContent,
				createdAt: humanCreatedAt,
			});
			const humanSig = signMessage(HUMAN, humanCanon, keyDir);
			const humanMsg = store.postMessage({
				channelId: boardroom.id,
				authorId: HUMAN,
				content: humanContent,
				sig: humanSig,
			});
			humanPosts++;

			// 3. Produce the reply ON the officer's assigned local backend.
			const messages: LLMMessage[] = [
				{ role: "system", content: officer.systemPrompt },
				{ role: "user", content: humanContent },
			];
			const inferred = await timeout(
				inferOnBackend(officer, messages),
				TIMEOUT_MS[officer.provider],
				`${officer.code}/${officer.provider}`,
			);
			note = inferred.note;
			replyFull = inferred.text.trim();
			if (replyFull.length === 0) {
				throw new Error("backend returned an empty reply");
			}

			// 4. Post the reply into #boardroom, signed by the officer, ledgered.
			const replyCreatedAt = Date.now();
			const replyCanon = canonicalMessage({
				channelId: boardroom.id,
				authorId: agentId,
				content: replyFull,
				createdAt: replyCreatedAt,
			});
			const replySig = signMessage(agentId, replyCanon, keyDir);
			if (!verifyMessage(agentId, replyCanon, replySig, keyDir)) {
				throw new Error("officer signature failed self-verification");
			}
			const replyMsg = store.postMessage({
				channelId: boardroom.id,
				authorId: agentId,
				content: replyFull,
				replyTo: humanMsg.id,
				sig: replySig,
			});
			ledgerRecorded = replyMsg.id.startsWith("msg_");
			status = "OK";
		} catch (err) {
			note = note || "error";
			replyFull = "";
			status = "FAILED";
			const msg = err instanceof Error ? err.message : String(err);
			note = `FAILED: ${msg}`;
		} finally {
			pool.destroySession(sid);
		}

		const oneLine = replyFull.replace(/\s+/g, " ").trim();
		results.push({
			code: officer.code,
			name: officer.name,
			provider: officer.provider,
			model: officer.model,
			endpoint: officer.baseUrl,
			f4,
			status,
			reply: oneLine.slice(0, 120),
			replyFull,
			note,
			ledgerRecorded,
			ms: Date.now() - started,
		});
	}

	// ── Result table ────────────────────────────────────────────────────────
	console.log(`\n=================== LOCAL-MESH RESULT TABLE ===================\n`);
	for (const r of results) {
		console.log(`[${r.status}] ${r.code} ${r.name}  (${r.provider} / ${r.model})`);
		console.log(`        endpoint : ${r.endpoint}`);
		console.log(`        F4 gate  : ${r.f4}`);
		console.log(`        ledger   : ${r.ledgerRecorded ? "yes" : "no"}   (${r.ms}ms)`);
		console.log(`        note     : ${r.note}`);
		if (r.status === "OK") {
			console.log(`        reply    : ${r.reply}${r.replyFull.length > 120 ? " ..." : ""}`);
		}
		console.log("");
	}

	// Compact one-line-per-officer summary (copy-pasteable).
	console.log(`------------------- ONE-LINE SUMMARY --------------------`);
	for (const r of results) {
		console.log(
			`${r.code} ${r.name} | ${r.provider} | ${r.model} | ${r.status} | ledger=${
				r.ledgerRecorded ? "yes" : "no"
			} | ${r.status === "OK" ? r.reply : r.note}`,
		);
	}

	// Full reply text (verbatim, per backend) — the "what the officer said" record.
	console.log(`\n=================== FULL REPLIES (verbatim) ===================\n`);
	for (const r of results) {
		if (r.status !== "OK") continue;
		console.log(`--- ${r.code} ${r.name} @ ${r.provider} (${r.model}) ---`);
		console.log(r.replyFull);
		console.log("");
	}

	// ── Ledger verify + one-post-per-reply assertion ─────────────────────────
	const vr = store.getLedger().verify();
	const okCount = results.filter((r) => r.status === "OK").length;

	const ledgerFile = path.join(ledgerBase, runId, "ledger.jsonl");
	const entries = fs
		.readFileSync(ledgerFile, "utf8")
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as { kind: string; payload: Record<string, unknown> });
	const kinds = entries.reduce<Record<string, number>>((acc, e) => {
		acc[e.kind] = (acc[e.kind] ?? 0) + 1;
		return acc;
	}, {});
	const officerPosts = entries.filter(
		(e) =>
			e.kind === "table.message.post" &&
			typeof e.payload.authorId === "string" &&
			(e.payload.authorId as string).startsWith("agent:"),
	).length;
	const humanPostEntries = entries.filter(
		(e) =>
			e.kind === "table.message.post" &&
			typeof e.payload.authorId === "string" &&
			(e.payload.authorId as string).startsWith("human:"),
	).length;

	console.log(`\n=================== LEDGER + ASSERTIONS ===================\n`);
	console.log(`ledger.verify() -> ${JSON.stringify({ ok: vr.ok, count: vr.count })}`);
	console.log(`ledger kinds     -> ${JSON.stringify(kinds)}`);
	console.log(
		`officer reply posts (agent:*) = ${officerPosts}  | successful officers = ${okCount}  -> ${
			officerPosts === okCount ? "MATCH" : "MISMATCH"
		}`,
	);
	console.log(
		`human @mention posts (human:*) = ${humanPostEntries}  | mentions sent = ${humanPosts}  -> ${
			humanPostEntries === humanPosts ? "MATCH" : "MISMATCH"
		}`,
	);

	const assertionsOk =
		vr.ok === true && officerPosts === okCount && humanPostEntries === humanPosts;

	console.log(
		`\nRESULT: ${okCount}/${SELECTED_CODES.length} backends replied | ledger ${
			vr.ok ? "OK" : "BROKEN"
		} | one-post-per-reply ${officerPosts === okCount ? "OK" : "FAIL"}`,
	);
	console.log(`Table is ${okCount > 0 && vr.ok ? "UP on the local mesh" : "NOT fully up"}.\n`);

	store.close();
	fs.rmSync(tmp, { recursive: true, force: true });
	// AgentPool holds a cleanup interval; exit deterministically.
	process.exit(assertionsOk && okCount === SELECTED_CODES.length ? 0 : 1);
}

main().catch((err) => {
	console.error("harness crashed:", err);
	process.exit(2);
});
