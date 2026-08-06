/**
 * Per-officer durable memory - the "mini vessel" state that survives daemon
 * restarts and session evictions. Concept imported from Buzz's relay-stored
 * agent memories + self-compaction (clean-room: concept only, no code).
 *
 * One markdown file per officer at ~/.8gent/table/memory/<CODE>.md:
 *
 *   ## Facts            <- curated durable facts/preferences (survives compaction)
 *   ## Recent exchanges <- rolling log of conversations (compacted when large)
 *
 * The memory is injected into every Table turn as DATA (never instructions) and
 * appended after every reply, so an officer genuinely accumulates context over
 * time - and the file is harness-portable: any runtime that can read markdown
 * inherits the officer's memory (Buzz's "portable context" idea).
 *
 * Compaction is DETERMINISTIC (keep Facts + newest N exchange lines). Model-run
 * self-summarisation can layer on later; determinism first.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = () =>
	path.join(process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent"), "table", "memory");

/** Max bytes injected into a prompt (tail-biased: newest context wins). */
const INJECT_CAP = 4_000;
/** File size that triggers compaction. */
const COMPACT_AT = 24_000;
/** Exchange lines kept after compaction. */
const KEEP_LINES = 40;

const FACTS_HEADER = "## Facts";
const LOG_HEADER = "## Recent exchanges";

/**
 * Memory is partitioned per (officer, channel). A single file per officer leaked
 * every channel's content into every other channel's prompt - an officer in a
 * private room and in #general would carry the private room's notes into the
 * public one. Membership is enforced on the read path, so this was the one
 * remaining side channel; partitioning closes it.
 *
 * `channelId` is optional ONLY so existing callers keep compiling during the
 * rollout; unpartitioned use falls back to a clearly-named shared file and
 * should be migrated. Prefer always passing the channel.
 */
export function memoryPath(code: string, channelId?: string): string {
	const dir = path.join(BASE(), code.toUpperCase());
	const leaf = channelId ? `${safeLeaf(channelId)}.md` : "_shared.md";
	return path.join(dir, leaf);
}

/** A channel id is already opaque hex, but never let one escape its directory. */
function safeLeaf(channelId: string): string {
	return channelId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "_unknown";
}

/**
 * Move a pre-partition flat file out of the injection path. Its entries mix
 * channels, so re-injecting it would reintroduce the leak; it is preserved on
 * disk for forensics but never read back into a prompt.
 */
function migrateLegacyFlatFile(code: string): void {
	const legacy = path.join(BASE(), `${code.toUpperCase()}.md`);
	if (!fs.existsSync(legacy)) return;
	try {
		const dir = path.join(BASE(), code.toUpperCase());
		fs.mkdirSync(dir, { recursive: true });
		fs.renameSync(legacy, path.join(dir, "_legacy-flat-DO-NOT-INJECT.md"));
	} catch {
		/* best effort: a failed migration must never break a reply */
	}
}

function ensureFile(code: string, channelId?: string): string {
	migrateLegacyFlatFile(code);
	const p = memoryPath(code, channelId);
	if (!fs.existsSync(p)) {
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(
			p,
			`# ${code.toUpperCase()} memory${channelId ? ` - channel ${channelId}` : ""}\n\n${FACTS_HEADER}\n\n${LOG_HEADER}\n`,
		);
	}
	return p;
}

/**
 * Drop an officer's memory for one channel. Call when the officer is removed
 * from that channel: leaving a room must not leave its notes behind.
 */
export function purgeChannelMemory(code: string, channelId: string): void {
	try {
		fs.rmSync(memoryPath(code, channelId), { force: true });
	} catch {
		/* best effort */
	}
}

/** The officer's memory, capped for prompt injection (facts + newest log tail). */
export function loadMemory(code: string, channelId?: string): string {
	migrateLegacyFlatFile(code);
	const p = memoryPath(code, channelId);
	let raw: string;
	try {
		raw = fs.readFileSync(p, "utf8");
	} catch {
		return "";
	}
	if (raw.length <= INJECT_CAP) return raw;
	// Keep the Facts section whole; tail the log to fit.
	const logAt = raw.indexOf(LOG_HEADER);
	const facts = logAt >= 0 ? raw.slice(0, logAt) : "";
	const log = logAt >= 0 ? raw.slice(logAt) : raw;
	const notice = `${LOG_HEADER}\n…(older exchanges compacted)…\n`;
	// Budget the notice itself, else the return overruns INJECT_CAP by its length.
	const room = Math.max(500, INJECT_CAP - facts.length - notice.length);
	const tail = log.length > room ? notice + log.slice(-room) : log;
	return facts + tail;
}

/** Append one exchange to the rolling log; compact when the file grows large. */
export function appendExchange(
	code: string,
	channelName: string,
	from: string,
	userText: string,
	replyText: string,
	channelId?: string,
): void {
	const p = ensureFile(code, channelId);
	const day = new Date().toISOString().slice(0, 10);
	const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
	// 90 chars silently truncated the very facts a human asked to be remembered
	// ("remember this: <fact>" lost its payload mid-sentence). 240 keeps the fact.
	const line = `- ${day} #${channelName} ${from}: "${clip(userText, 240)}" -> me: "${clip(replyText, 240)}"\n`;
	fs.appendFileSync(p, line);
	// An explicit "remember this" is a DURABLE fact, not a passing exchange: promote
	// it into ## Facts so it survives compaction. appendFact had zero callers, which
	// made the whole two-tier design a no-op in practice.
	if (/\b(remember|note) (this|that)\b|\bfor the record\b|\bdon't forget\b/i.test(userText)) {
		appendFact(code, `${from} asked me to remember: ${clip(userText, 240)}`, channelId);
	}
	compactIfNeeded(p);
}

/** Add a durable fact (preference, decision, standing context) to ## Facts. */
export function appendFact(code: string, fact: string, channelId?: string): void {
	const p = ensureFile(code, channelId);
	const raw = fs.readFileSync(p, "utf8");
	const day = new Date().toISOString().slice(0, 10);
	const entry = `- ${day} ${fact.replace(/\s+/g, " ").trim().slice(0, 200)}\n`;
	const at = raw.indexOf(LOG_HEADER);
	const updated = at >= 0
		? `${raw.slice(0, at)}${entry}\n${raw.slice(at)}`
		: raw + `\n${FACTS_HEADER}\n${entry}`;
	fs.writeFileSync(p, updated);
}

/** Deterministic compaction: keep header + Facts intact, newest N log lines. */
function compactIfNeeded(p: string): void {
	let raw: string;
	try {
		raw = fs.readFileSync(p, "utf8");
	} catch {
		return;
	}
	if (raw.length < COMPACT_AT) return;
	const logAt = raw.indexOf(LOG_HEADER);
	if (logAt < 0) return;
	const head = raw.slice(0, logAt);
	const logLines = raw
		.slice(logAt + LOG_HEADER.length)
		.split("\n")
		.filter((l) => l.trim().startsWith("- "));
	const kept = logLines.slice(-KEEP_LINES);
	fs.writeFileSync(
		p,
		`${head}${LOG_HEADER}\n…(compacted ${logLines.length - kept.length} older exchanges on ${new Date().toISOString().slice(0, 10)})…\n${kept.join("\n")}\n`,
	);
}
