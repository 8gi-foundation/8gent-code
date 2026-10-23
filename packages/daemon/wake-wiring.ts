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
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
		return { ...DEFAULT_WAKE_SETTINGS, ...w };
	} catch {
		return { ...DEFAULT_WAKE_SETTINGS };
	}
}

/** Untrusted text goes to a private file under the data dir; the event carries the path only. */
function stash(text: string, dir = getDataDir()): string {
	const d = join(dir, "wake");
	mkdirSync(d, { recursive: true, mode: 0o700 });
	const p = join(d, `${sha(text)}.txt`);
	writeFileSync(p, text, { mode: 0o600 });
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

function cronEvent(priority: WakeEvent["priority"], key: string, text: string): WakeEvent {
	return {
		source: "cron",
		priority,
		dedupeKey: `cron:${key}`,
		origin: "cron",
		payloadPath: stash(text),
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
): () => void {
	router = new WakeRouter({
		settings: () => readWakeSettings(dir),
		digestDir: join(dir, "digest"),
		speak,
	});
	const r = router;
	const subs = [
		bus.on("tool:result", (p) => {
			if (p.sessionId !== "cron" || !p.tool.startsWith("cron:") || p.tool === "cron:when") return;
			const text = JSON.stringify(p.output) ?? "";
			void r.submit(cronEvent("low", `${p.tool}:${sha(text)}`, text));
			if (p.tool === "cron:shell") {
				const root = join(dir, "security", "threat-feed");
				for (const e of threatFeedEvents(root, Date.now() - p.durationMs - 60_000))
					void r.submit(e);
			}
		}),
		// A failed job needs action; the same failure on a retry is one event.
		bus.on("agent:error", (p) => {
			if (p.sessionId === "cron")
				void r.submit(cronEvent("urgent", `error:${sha(p.error)}`, p.error));
		}),
	];
	return () => {
		for (const id of subs) bus.off(id);
		void r.flush();
		router = null;
	};
}
