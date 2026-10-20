/**
 * /telegram setup (#4594): connect your own Telegram bot without editing JSON.
 *
 * The bot key lives only in a file the person fills in outside the TUI. It is
 * read inside this process, sent only to the Bot API, and never returned in
 * the text this module produces, so it cannot reach the screen, the model's
 * context or a log. The settings it writes are read once at process start and
 * each chat still needs a per-process approval card; neither is weakened here.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { apiBase, readBotKey } from "../../../../packages/ai/post-message.js";

export const DEFAULT_ENV_FILE = "~/.8gent/secrets/telegram-bot.env";
export const DEFAULT_TOKEN_VAR = "TELEGRAM_BOT_TOKEN";

const BOT_TOKEN_RE = /(?:bot)?\d{6,}:[A-Za-z0-9_-]{20,}/g;
const CHAT_ID_RE = /^-?\d{1,20}$/;
const homeDir = () => process.env.HOME || homedir();

export interface SeenChat {
	id: string;
	label: string;
	kind: string;
}

const expand = (p: string) => (p.startsWith("~/") ? join(homeDir(), p.slice(2)) : p);

/** Remove the key, its URL-encoded forms and anything token-shaped. */
export function redact(text: string, key?: string | null): string {
	let out = text;
	if (key)
		for (const f of [key, encodeURIComponent(key)]) out = out.split(f).join("[redacted-token]");
	return out.replace(BOT_TOKEN_RE, "[redacted-token]");
}

/** Create the key file (0600, in a 0700 directory) with an empty placeholder if missing. */
export function ensureEnvFile(file: string): { created: boolean } {
	const path = expand(file);
	if (existsSync(path)) return { created: false };
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(
		path,
		`# Telegram bot key from @BotFather. Paste it after the = sign and save. Keep this file private.\n${DEFAULT_TOKEN_VAR}=\n`,
		{ mode: 0o600, flag: "wx" },
	);
	chmodSync(path, 0o600);
	return { created: true };
}

async function botCall(
	key: string,
	method: string,
	body: Record<string, unknown>,
): Promise<{ result?: unknown; error?: string }> {
	const api = apiBase();
	if (!api.base) return { error: api.error };
	try {
		const res = await fetch(`${api.base}/bot${key}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			redirect: "error",
			signal: AbortSignal.timeout(8000),
		});
		const j = (await res.json().catch(() => null)) as {
			ok?: boolean;
			result?: unknown;
			description?: string;
		} | null;
		if (j?.ok) return { result: j.result };
		const why = redact(String(j?.description ?? `HTTP ${res.status}`), key);
		return {
			error: res.status === 401 || res.status === 404 ? "Telegram did not accept that key" : why,
		};
	} catch (e) {
		return {
			error: `could not reach Telegram (${redact(e instanceof Error ? e.name : "error", key)})`,
		};
	}
}

export async function getMe(key: string): Promise<{ username?: string; error?: string }> {
	const r = await botCall(key, "getMe", {});
	if (r.error) return { error: r.error };
	const u = (r.result as { username?: string } | undefined)?.username;
	return u ? { username: u } : { error: "Telegram returned no bot name" };
}

/** One getUpdates call, no offset (so nothing is acknowledged) and no long poll. */
export async function getSeenChats(key: string): Promise<{ chats?: SeenChat[]; error?: string }> {
	const r = await botCall(key, "getUpdates", {
		timeout: 0,
		limit: 100,
		allowed_updates: ["message", "channel_post", "my_chat_member"],
	});
	if (r.error) return { error: r.error };
	const seen = new Map<string, SeenChat>();
	for (const u of (r.result as Record<string, any>[]) ?? []) {
		const chat = (u.message ?? u.channel_post ?? u.my_chat_member)?.chat;
		if (!chat || chat.id === undefined) continue;
		const id = String(chat.id);
		const person = [chat.first_name, chat.last_name].filter(Boolean).join(" ");
		const label = String(chat.title ?? (person || chat.username || "unnamed chat"));
		seen.set(id, { id, label, kind: String(chat.type ?? "chat") });
	}
	return { chats: [...seen.values()] };
}

/** Add chat ids and the key-file settings, keeping every other key and every existing chat. */
export function mergeSettings(
	chatIds: string[],
	envFile: string,
	tokenVar: string,
): { ok: boolean; error?: string; added: string[] } {
	const path = join(homeDir(), ".8gent", "settings.json");
	let settings: Record<string, any> = {};
	if (existsSync(path)) {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				throw new Error("not an object");
			settings = parsed;
		} catch {
			return {
				ok: false,
				error: "~/.8gent/settings.json is not valid JSON; fix it and run this again",
				added: [],
			};
		}
	}
	const pm =
		settings.postMessage && typeof settings.postMessage === "object" ? settings.postMessage : {};
	const existing: string[] = Array.isArray(pm.allowedChats) ? pm.allowedChats.map(String) : [];
	const added = chatIds.filter((c) => !existing.includes(c));
	settings.postMessage = {
		...pm,
		allowedChats: [...existing, ...added],
		botEnvFile: envFile,
		botTokenVar: tokenVar,
	};
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
	return { ok: true, added };
}

function configured(): { file: string; name: string } {
	try {
		const pm = JSON.parse(
			readFileSync(join(homeDir(), ".8gent", "settings.json"), "utf8"),
		)?.postMessage;
		const file = typeof pm?.botEnvFile === "string" ? pm.botEnvFile : DEFAULT_ENV_FILE;
		const name =
			typeof pm?.botTokenVar === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(pm.botTokenVar)
				? pm.botTokenVar
				: DEFAULT_TOKEN_VAR;
		return { file, name };
	} catch {
		return { file: DEFAULT_ENV_FILE, name: DEFAULT_TOKEN_VAR };
	}
}

const RESTART =
	"Restart 8gent for this to take effect. The first post to each chat then asks you to approve it.";

/** `/telegram setup [chat id ...]` -> the text to show. Never contains the key. */
export async function runTelegramSetup(args: string[]): Promise<string> {
	const { file, name } = configured();
	let created = false;
	try {
		created = ensureEnvFile(file).created;
	} catch {
		return `Could not create ${file}. Create it yourself with ${name}=<your key>, chmod 600, then run /telegram setup again.`;
	}
	const key = readBotKey(expand(file), name);
	if (!key) {
		return [
			"Telegram setup, step 1 of 3: create your bot.",
			"  1. In Telegram, open @BotFather and send /newbot.",
			"  2. Copy the key it gives you.",
			`  3. Open ${file} in an editor, put the key after ${name}=, and save.`,
			created ? `     (I just created that file, private to you, with an empty ${name}=.)` : "",
			"Do not paste the key here. Then run /telegram setup again.",
		]
			.filter(Boolean)
			.join("\n");
	}
	const me = await getMe(key);
	if (!me.username)
		return `Telegram setup: ${redact(me.error ?? "failed", key)}. Check the key in ${file}.`;

	const seen = await getSeenChats(key);
	if (!seen.chats)
		return `Telegram setup: @${me.username} is valid but chats could not be read: ${redact(seen.error ?? "failed", key)}`;

	const picks = args.filter((a) => a.length > 0);
	if (picks.length === 0) {
		const lines = [`Telegram setup, step 2 of 3: your bot is @${me.username}.`];
		if (seen.chats.length === 0) {
			lines.push(
				`No chats yet. Message @${me.username} in Telegram (or add it to a group and send a message), then run /telegram setup again.`,
			);
		} else {
			lines.push(
				"Chats it can see:",
				...seen.chats.map((c) => `  ${c.id}  ${c.label} (${c.kind})`),
			);
			lines.push("Pick one or more: /telegram setup <chat id> [<chat id> ...]");
		}
		return lines.join("\n");
	}
	const bad = picks.find((p) => !CHAT_ID_RE.test(p));
	if (bad) return `"${bad.slice(0, 24)}" is not a chat id. Run /telegram setup to see the list.`;
	const unknown = picks.find((p) => !seen.chats?.some((c) => c.id === p));
	if (unknown)
		return `Chat ${unknown} is not one @${me.username} has seen. Message the bot there first, then run /telegram setup.`;

	const w = mergeSettings(picks, file, name);
	if (!w.ok) return `Telegram setup: ${w.error}`;
	const done = picks.map((p) => `${p} ${seen.chats?.find((c) => c.id === p)?.label ?? ""}`.trim());
	return [
		`Telegram setup done for @${me.username}.`,
		`Allowed chats: ${done.join(", ")}${w.added.length < picks.length ? " (some were already allowed)" : ""}.`,
		`Key file: ${file} (variable ${name}).`,
		RESTART,
	].join("\n");
}
