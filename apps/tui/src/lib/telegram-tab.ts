/**
 * The Telegram tab (#4834): `/sessions attach home` opens one dedicated tab that is the
 * Telegram conversation. Only that tab is linked; every other tab, and its messages, are
 * never touched. The tab's label says the state: linked, reconnecting or detached. Closing
 * the tab detaches it.
 *
 * Pure of React: app.tsx supplies a host (what a tab is), so the rule "attach never
 * rewrites another tab" is testable against a real daemon without rendering.
 */

import {
	type AttachedSession,
	type DaemonChatEvent,
	DaemonSessionClient,
	surfaceLabel,
} from "./daemon-sessions";

export type TelegramTabState = "linked" | "reconnecting" | "detached";

/** Marks the tab in its data, so it is found again and never saved to disk. */
export const TELEGRAM_TAB_DATA_KEY = "telegramHome";

/** Short and plain; the tab bar already styles titles, so no colour of its own. */
export function telegramTabTitle(state: TelegramTabState): string {
	return `Telegram ${state}`;
}

/**
 * Text that came from Telegram, or from a model reading it, is drawn in a terminal:
 * control characters could move the cursor, set the window title or run an OSC
 * sequence, and format characters (bidi overrides, zero-width marks) can disguise a
 * line. Strip C0 (keeping newline and tab), DEL, C1 and every Unicode format character.
 * Removing the ESC leaves a sequence's tail as inert visible text.
 */
export function sanitizeForTerminal(text: string): string {
	let out = "";
	for (const ch of text) {
		const c = ch.codePointAt(0) ?? 0;
		if (c < 0x20 && c !== 0x09 && c !== 0x0a) continue;
		if (c >= 0x7f && c <= 0x9f) continue;
		if (/\p{Cf}/u.test(ch)) continue;
		out += ch;
	}
	return out;
}

export interface TabMsg {
	id: string;
	role: "user" | "assistant" | "system";
	content: string;
	timestamp: Date;
}

/** What the controller needs from the TUI. Each call names the tab it acts on. */
export interface TelegramTabHost {
	/** Open a new tab, or null when none can be made (the tab limit). */
	addTab(title: string, data: Record<string, unknown>): { id: string } | null;
	hasTab(id: string): boolean;
	switchTab(id: string): void;
	renameTab(id: string, title: string): void;
	/** Replace the messages of this tab only. */
	setMessages(id: string, messages: TabMsg[]): void;
	append(id: string, message: TabMsg): void;
	/** A line for the person when there is no Telegram tab to put it in. */
	notify(text: string): void;
}

type Connect = () => Promise<{ client: DaemonSessionClient; attached: AttachedSession }>;

export class TelegramTab {
	private tabId: string | null = null;
	private client: DaemonSessionClient | null = null;
	private off: (() => void) | null = null;
	private seq = 0;

	constructor(
		private host: TelegramTabHost,
		private connect: Connect = () => DaemonSessionClient.connectHome(),
	) {}

	/** The tab this controller owns, while it exists (linked or detached). */
	get id(): string | null {
		return this.tabId;
	}

	/** Is this tab the Telegram tab? */
	owns(tabId: string): boolean {
		return this.tabId !== null && this.tabId === tabId;
	}

	get linked(): boolean {
		return this.client !== null;
	}

	private msg(role: TabMsg["role"], content: string): TabMsg {
		// Every line in this tab passes through here: names, text, replies, errors, tools, history.
		return {
			id: `telegram-${Date.now()}-${this.seq++}`,
			role,
			content: sanitizeForTerminal(content),
			timestamp: new Date(),
		};
	}

	private transcript(rows: Array<{ role: string; content: string }>): TabMsg[] {
		return rows.map((m) => this.msg(m.role === "user" ? "user" : "assistant", m.content));
	}

	private state(state: TelegramTabState): void {
		if (this.tabId) this.host.renameTab(this.tabId, telegramTabTitle(state));
	}

	/**
	 * Open the Telegram tab, or reuse it. Connects first, so a daemon with no home session
	 * opens no tab. Replaces only the Telegram tab's messages, then switches to it.
	 */
	async open(): Promise<boolean> {
		if (this.tabId && !this.host.hasTab(this.tabId)) this.tabsChanged();
		if (this.client && this.tabId) {
			this.host.switchTab(this.tabId);
			return true;
		}
		let linked: Awaited<ReturnType<Connect>>;
		try {
			linked = await this.connect();
		} catch (err) {
			this.host.notify(
				`Could not open your 8gent's Telegram session: ${err instanceof Error ? err.message : String(err)}`,
			);
			return false;
		}
		let tabId = this.tabId;
		if (!tabId) {
			const tab = this.host.addTab(telegramTabTitle("linked"), { [TELEGRAM_TAB_DATA_KEY]: true });
			if (!tab) {
				linked.client.close();
				this.host.notify("Could not open a Telegram tab (too many tabs open).");
				return false;
			}
			tabId = tab.id;
			this.tabId = tabId;
		}
		const id = tabId;
		this.client = linked.client;
		this.host.setMessages(id, [
			...this.transcript(linked.attached.transcript),
			this.msg(
				"system",
				`Linked to your 8gent's Telegram conversation${linked.attached.truncated ? ", older messages not shown" : ""}. What you type here stays in this tab and is never posted to Telegram.`,
			),
		]);
		this.off = linked.client.onEvent((e) => this.onEvent(id, e));
		this.state("linked");
		this.host.switchTab(id);
		return true;
	}

	private onEvent(tabId: string, e: DaemonChatEvent): void {
		switch (e.kind) {
			case "user": {
				const from = e.channel === "telegram" ? "Telegram" : surfaceLabel(e.channel);
				this.host.append(tabId, this.msg("user", `[${from}] ${e.text}`));
				break;
			}
			case "reply":
				this.host.append(tabId, this.msg("assistant", e.text));
				break;
			case "tool":
				this.host.append(tabId, this.msg("system", `8gent is using ${e.tool}`));
				break;
			case "error":
				this.host.append(tabId, this.msg("system", `8gent: ${e.text}`));
				break;
			case "reconnecting":
				this.state("reconnecting");
				this.host.append(
					tabId,
					this.msg("system", "Reconnecting to your 8gent... Sending is paused until it is back."),
				);
				break;
			case "resynced":
				this.host.setMessages(tabId, [
					...this.transcript(e.transcript),
					this.msg("system", "Reconnected to your 8gent."),
				]);
				this.state("linked");
				break;
			case "ended":
				this.host.append(
					tabId,
					this.msg(
						"system",
						`The Telegram link ended (${e.reason || "closed"}). /sessions attach home links it again.`,
					),
				);
				this.release();
				break;
		}
	}

	/** Send what the person typed in the Telegram tab. Throws with a plain reason when it cannot. */
	send(text: string): void {
		if (!this.client) {
			throw new Error("this tab is detached from Telegram. /sessions attach home links it again");
		}
		this.client.prompt(text);
	}

	/** Leave the conversation. The tab stays, with its history, marked detached. */
	async detach(): Promise<boolean> {
		const client = this.client;
		if (!client) return false;
		await client.detach().catch(() => {});
		if (this.client === client) this.release();
		return true;
	}

	/** Drop the link, keep the tab id, mark the tab detached. */
	private release(): void {
		this.off?.();
		this.off = null;
		const client = this.client;
		this.client = null;
		client?.close();
		this.state("detached");
	}

	/** Call when the tab list changes: a closed Telegram tab detaches for good. */
	tabsChanged(): void {
		if (!this.tabId || this.host.hasTab(this.tabId)) return;
		this.off?.();
		this.off = null;
		const client = this.client;
		this.client = null;
		this.tabId = null;
		if (client) {
			void client.detach().catch(() => {});
			client.close();
		}
	}

	dispose(): void {
		this.off?.();
		this.off = null;
		this.client?.close();
		this.client = null;
	}
}
