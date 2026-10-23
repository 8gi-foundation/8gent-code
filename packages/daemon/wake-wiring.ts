/**
 * Wake router wiring (#4868): maps the triggers that already exist in the daemon onto
 * WakeEvents. Owner messages come from the gateway (TUI, and the Telegram home session),
 * Telegram messages from others from the bridge's observe path, cron results from the bus,
 * and threat-feed results from the report files a cron run leaves behind. No new source.
 *
 * Off unless EIGHT_WAKE_ROUTER=1. Action notices ride the existing native notification and
 * carry fixed words and a path, never text written by someone else.
 */

import { createHash } from "node:crypto";
import {
	constants,
	closeSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { getDataDir } from "./data-dir";
import { bus } from "./events";
import { sendNativeNotification } from "./notifications";
import {
	DEFAULT_WAKE_SETTINGS,
	type Notice,
	type WakeEvent,
	WakeRouter,
	type WakeSettings,
} from "./wake-router";

let router: WakeRouter | null = null;

/** The running router, or null when the flag is off. */
export const wakeRouter = (): WakeRouter | null => router;

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** `wake` block of config.json over the defaults. Read per decision, so a change applies live. */
export function readWakeSettings(dir = getDataDir()): WakeSettings {
	try {
		const w = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).wake ?? {};
		const s = { ...DEFAULT_WAKE_SETTINGS, ...w };
		// A prune limit that is not a positive number (0, negative, NaN, a string) would delete
		// everything: it falls back to the default instead (8SO, #4888).
		const positive = (v: unknown, fallback: number, max: number) =>
			typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(v, max) : fallback;
		s.payloadMaxAgeDays = positive(
			s.payloadMaxAgeDays,
			DEFAULT_WAKE_SETTINGS.payloadMaxAgeDays,
			3650,
		);
		s.payloadMaxFiles = Math.floor(
			positive(s.payloadMaxFiles, DEFAULT_WAKE_SETTINGS.payloadMaxFiles, 100_000),
		);
		if (s.payloadMaxFiles < 1) s.payloadMaxFiles = DEFAULT_WAKE_SETTINGS.payloadMaxFiles;
		return s;
	} catch {
		return { ...DEFAULT_WAKE_SETTINGS };
	}
}

/** Remove payload files past the age limit, then the oldest beyond the count cap (#4877). */
export function pruneWakeFiles(
	d: string,
	s: Pick<WakeSettings, "payloadMaxAgeDays" | "payloadMaxFiles">,
	now = Date.now(),
	/** Paths never removed: the file just written, and what held events point at. */
	keep: ReadonlySet<string> = new Set(),
): number {
	// The limits are checked again here: this is exported, and 0, a negative or NaN would remove everything.
	const days =
		Number.isFinite(s.payloadMaxAgeDays) && s.payloadMaxAgeDays > 0
			? s.payloadMaxAgeDays
			: DEFAULT_WAKE_SETTINGS.payloadMaxAgeDays;
	const cap =
		Number.isFinite(s.payloadMaxFiles) && s.payloadMaxFiles >= 1
			? Math.floor(s.payloadMaxFiles)
			: DEFAULT_WAKE_SETTINGS.payloadMaxFiles;
	let files: { p: string; at: number }[];
	try {
		// lstat: only regular files count; a link is never followed, so its target's age or
		// existence cannot steer what gets removed.
		files = readdirSync(d)
			.filter((f) => f.endsWith(".txt"))
			.map((f) => ({ p: join(d, f), st: lstatSync(join(d, f)) }))
			.filter((f) => f.st.isFile())
			.map((f) => ({ p: f.p, at: f.st.mtimeMs }))
			.sort((a, b) => a.at - b.at);
	} catch {
		return 0;
	}
	const cutoff = now - days * 86_400_000;
	const excess = Math.max(0, files.length - cap);
	const doomed = files.filter((f, i) => !keep.has(resolve(f.p)) && (f.at < cutoff || i < excess));
	for (const f of doomed) {
		try {
			unlinkSync(f.p);
		} catch {}
	}
	return doomed.length;
}

/** Write a 0600 file without following a link at its name (a planted link is replaced, not written through). */
function writeNoFollow(p: string, text: string): void {
	const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
	let fd: number;
	try {
		fd = openSync(p, flags, 0o600);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ELOOP") throw err;
		unlinkSync(p);
		fd = openSync(p, flags, 0o600);
	}
	try {
		writeSync(fd, text);
	} finally {
		closeSync(fd);
	}
}

/** Untrusted text goes to a private file under the data dir; the event carries the path only. */
function stash(text: string, dir = getDataDir()): string {
	const d = join(dir, "wake");
	mkdirSync(d, { recursive: true, mode: 0o700 });
	const p = join(d, `${sha(text)}.txt`);
	writeNoFollow(p, text);
	const keep = new Set([resolve(p), ...(router?.heldPaths() ?? [])]);
	pruneWakeFiles(d, readWakeSettings(dir), Date.now(), keep);
	return p;
}

/** The owner's own prompt: the TUI, or the Telegram home session (the bridge admits only the operator). */
export function ownerEvent(sessionId: string, channel: string, at = Date.now()): WakeEvent {
	return {
		source: "owner",
		priority: "owner",
		dedupeKey: `owner:${sessionId}:${at}`,
		origin: channel,
		payloadPath: `session://${sessionId}`,
		at,
	};
}

/** A Telegram message from someone who is not the owner: data, queued quiet, never an instruction. */
export function telegramOtherEvent(chatId: unknown, logPath: string, at = Date.now()): WakeEvent {
	return {
		source: "telegram-other",
		priority: "normal",
		dedupeKey: `telegram-other:${String(chatId)}`,
		origin: "telegram-other",
		payloadPath: logPath,
		at,
	};
}

/** One urgent event per CRITICAL hit in report files written since `sinceMs`. Feed text stays in the file. */
export function threatFeedEvents(root: string, sinceMs: number, at = Date.now()): WakeEvent[] {
	const out: WakeEvent[] = [];
	try {
		for (const day of readdirSync(root)) {
			const path = join(root, day, "report.json");
			let stat: ReturnType<typeof statSync>;
			try {
				stat = statSync(path);
			} catch {
				continue;
			}
			if (stat.mtimeMs < sinceMs) continue;
			const hits = JSON.parse(readFileSync(path, "utf8")).hits;
			for (const h of Array.isArray(hits) ? hits : []) {
				if (h?.severity !== "CRITICAL") continue;
				out.push({
					source: "threat-feed",
					priority: "urgent",
					dedupeKey: `threat-feed:${sha(`${h.repo}|${h.advisoryId}`)}`,
					origin: "threat-feed",
					payloadPath: path,
					at,
				});
			}
		}
	} catch {
		// No report, or one that does not parse: nothing to wake for.
	}
	return out;
}

function cronEvent(
	dir: string,
	priority: WakeEvent["priority"],
	key: string,
	text: string,
): WakeEvent {
	return {
		source: "cron",
		priority,
		dedupeKey: `cron:${key}`,
		origin: "cron",
		payloadPath: stash(text, dir),
		at: Date.now(),
	};
}

async function announce(n: Notice): Promise<void> {
	if (n.kind === "reply") return; // the owner's reply is the stream they are already reading
	await sendNativeNotification(
		"8gent",
		`${n.event.source} needs you, details at ${n.event.payloadPath}`,
	);
}

/** Start the router and subscribe it to the bus. Returns a stop function. */
export function startWakeRouter(
	dir = getDataDir(),
	speak: (n: Notice) => void | Promise<void> = announce,
	now?: () => number,
): () => void {
	router = new WakeRouter({
		settings: () => readWakeSettings(dir),
		digestDir: join(dir, "digest"),
		heldPath: join(dir, "wake-held.json"),
		speak,
		now,
	});
	const r = router;
	const subs = [
		bus.on("tool:result", (p) => {
			if (p.sessionId !== "cron" || !p.tool.startsWith("cron:") || p.tool === "cron:when") return;
			const text = JSON.stringify(p.output) ?? "";
			void r.submit(cronEvent(dir, "low", `${p.tool}:${sha(text)}`, text));
			if (p.tool === "cron:shell") {
				const root = join(dir, "security", "threat-feed");
				for (const e of threatFeedEvents(root, Date.now() - p.durationMs - 60_000))
					void r.submit(e);
			}
		}),
		// A failed job needs action; the same failure on a retry is one event.
		bus.on("agent:error", (p) => {
			if (p.sessionId === "cron")
				void r.submit(cronEvent(dir, "urgent", `error:${sha(p.error)}`, p.error));
		}),
	];
	return () => {
		for (const id of subs) bus.off(id);
		void r.flush();
		router = null;
	};
}
