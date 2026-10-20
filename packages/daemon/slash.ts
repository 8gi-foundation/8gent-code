/**
 * Slash commands for non-TUI surfaces (#4530).
 *
 * The TUI owns the registry (apps/tui/src/lib/slash-commands.ts) but runs each
 * command inside a React callback, so no other surface could use one. This is
 * the headless side: the gateway hands a leading-slash line here before the
 * model sees it. `handled: false` is the only case that falls through to the
 * model, so a typo or an unknown name is the only way a slash line becomes a
 * prompt. Names come from the TUI registry, so `/help` cannot drift from it.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BUILT_IN_SLASH_COMMANDS } from "../../apps/tui/src/lib/slash-commands";
import { DJ, bedsDir } from "../music/dj";
import { getJobs } from "./cron";

export interface SlashContext {
	sessionId: string;
	channel: string;
	model?: string;
	runtime?: string;
	messageCount?: number;
	busy?: boolean;
}

export interface SlashResult {
	handled: boolean;
	text?: string;
}

/** Commands this module can run without a terminal. Everything else in the registry is TUI-only. */
const HEADLESS = new Set([
	"help",
	"status",
	"model",
	"provider",
	"session",
	"cron",
	"goal",
	"subgoal",
	"dj",
	"music",
]);

const dj = new DJ();

/** First audio file in the beds dir whose name contains every word of the query (case-insensitive). */
export function matchBed(query: string, dir = bedsDir()): string | null {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0 || !existsSync(dir)) return null;
	for (const f of readdirSync(dir).sort()) {
		if (!/\.(mp3|wav|m4a|flac|ogg)$/i.test(f)) continue;
		const name = f.toLowerCase();
		if (words.every((w) => name.includes(w))) return join(dir, f);
	}
	return null;
}

/** Token (name or alias, no slash) to canonical registry name. */
function resolve(token: string): string | null {
	const t = token.toLowerCase();
	for (const c of BUILT_IN_SLASH_COMMANDS) {
		if (c.name === t || c.aliases.includes(t)) return c.name;
	}
	return null;
}

function helpText(): string {
	const lines = BUILT_IN_SLASH_COMMANDS.map((c) => {
		const here = HEADLESS.has(c.name) ? "" : "  (terminal only)";
		return `/${c.name} - ${c.description}${here}`;
	});
	return `Commands (same list as the 8gent TUI):\n${lines.join("\n")}`;
}

async function runDj(args: string[]): Promise<string> {
	const sub = (args[0] ?? "").toLowerCase();
	const rest = args.slice(1).join(" ").trim();
	switch (sub) {
		case "play": {
			if (!rest) return "Usage: /dj play <query>";
			const bed = matchBed(rest);
			if (bed) return `[bed] ${await dj.play(bed)}`;
			// A bed, an http(s) URL or a search term; never a path.
			if (/^(\/|~|\.|file:)/i.test(rest))
				return "Refused: /dj play takes a bed name, a URL or a search, not a file path.";
			return `[youtube] ${await dj.play(rest)}`;
		}
		case "radio":
			return dj.radio(rest || "lofi");
		case "pause":
			return dj.pause();
		case "resume":
			return dj.resume();
		case "stop":
			return dj.stop();
		case "skip":
			return dj.skip();
		case "np":
			return dj.nowPlaying();
		case "queue":
			return rest ? dj.queue(rest) : "Usage: /dj queue <query>";
		case "vol": {
			const n = Number(rest);
			return Number.isFinite(n)
				? dj.volume(Math.max(0, Math.min(100, n)))
				: "Usage: /dj vol <0-100>";
		}
		case "":
		case "status": {
			const s = await dj.status();
			return s.playing
				? `${s.paused ? "Paused" : "Playing"}: ${s.title} (volume ${s.volume ?? "unknown"})`
				: "DJ idle. Try /dj play <query> or /dj radio lofi.";
		}
		default:
			return "Usage: /dj [play|radio|pause|resume|stop|skip|np|vol|queue|status]";
	}
}

/**
 * Run one slash line. Not a slash line, or a name the registry does not know,
 * returns { handled: false } so the caller sends it to the model unchanged.
 */
export async function runSlash(line: string, ctx: SlashContext): Promise<SlashResult> {
	const trimmed = line.trim();
	if (!trimmed.startsWith("/")) return { handled: false };
	const [head, ...args] = trimmed.slice(1).split(/\s+/);
	const name = resolve(head);
	// A slash line never reaches the model: an unknown name is answered here.
	if (!name) return { handled: true, text: `Unknown command /${head.slice(0, 40)}. Type /help.` };
	if (name === "help") return { handled: true, text: helpText() };
	if (!HEADLESS.has(name)) {
		return {
			handled: true,
			text: `/${name} is not available in the ${ctx.channel === "browser" ? "browser chat" : `${ctx.channel} channel`}. It runs in the 8gent terminal.`,
		};
	}
	try {
		switch (name) {
			case "dj":
			case "music":
				return { handled: true, text: await runDj(name === "music" ? ["status"] : args) };
			case "status":
				return {
					handled: true,
					text: `Session ${ctx.sessionId} on channel ${ctx.channel}: ${ctx.messageCount ?? 0} messages, ${ctx.busy ? "busy" : "idle"}.`,
				};
			case "model":
				return {
					handled: true,
					text: `Model: ${ctx.model ?? "unknown"}. Switching models is a terminal command.`,
				};
			case "provider":
				return {
					handled: true,
					text: `Provider: ${ctx.runtime ?? "unknown"}. Switching providers is a terminal command.`,
				};
			case "session":
				return {
					handled: true,
					text: `Current session: ${ctx.sessionId} (channel ${ctx.channel}).`,
				};
			case "cron": {
				const jobs = getJobs();
				return {
					handled: true,
					text: jobs.length
						? jobs
								.map(
									(j) =>
										`${j.enabled ? "on " : "off"} ${j.name} (${j.expression}) next ${j.nextRun ?? "none"}`,
								)
								.join("\n")
						: "No scheduled jobs.",
				};
			}
			default:
				return {
					handled: true,
					text: `/${name} starts a goal loop in the terminal; this channel can only read, not start one.`,
				};
		}
	} catch (err) {
		return {
			handled: true,
			text: `/${name} failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}
