/**
 * The desktop approval card (8SO, #4057). Pure text so it is testable:
 * what will happen, where, the exact text for a `type`, and the screen
 * around the point. The card is shown to the person and nowhere else; what
 * gets logged is `desktopApprovalDetails`, which never carries typed text.
 */
import type { DesktopActApproval } from "./desktop-act";

/** Terminal escape sequences, 7-bit and C1: CSI, OSC/DCS/PM/APC strings, and two-byte ESC forms. */
const ESCAPES =
	/\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|(?:\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f])[\s\S]*?(?:\x07|\x1b\\|\x9c|$)|\x1b[ -~]?/g;
/** Every control left after that, bidi overrides and isolates, and the Unicode line/paragraph separators. */
const CONTROLS = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g;
/** What JSON.stringify leaves raw that a terminal would still act on. */
const JSON_RAW_CONTROLS = /[\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g;

/** One line of plain text for the card: nothing in it can move the cursor, erase a line or reorder what is shown. */
export function cardText(s: string): string {
	return s.replace(ESCAPES, "").replace(CONTROLS, "");
}

/** Typed text shown as a literal: JSON, plus \u escapes for DEL, C1, bidi and U+2028/9. */
export function inertLiteral(s: string): string {
	return JSON.stringify(s).replace(
		JSON_RAW_CONTROLS,
		(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

export function desktopApprovalCard(req: DesktopActApproval, reason: string): string {
	const lines = [
		`${req.attempt > 1 ? "AGAIN, target moved: " : ""}${req.action.replace("_", " ")} ${cardText(req.target)}`,
		`at screen point (${req.point.x}, ${req.point.y}), grounder confidence ${req.confidence}`,
	];
	if (req.keys) lines.push(`keys: ${cardText(req.keys)}`);
	if (req.action === "type") lines.push(`will type exactly: ${inertLiteral(req.text ?? "")}`);
	lines.push(cardText(reason));
	if (req.crop) lines.push(req.crop);
	return lines.join("\n");
}

/** The loggable summary: no typed text, no crop. */
export function desktopApprovalDetails(req: DesktopActApproval, reason: string): string {
	const { text: _text, crop: _crop, ...safe } = req;
	return `${reason} Tool: desktop_act ${JSON.stringify(safe)}`;
}

/** Strip typed text from desktop tool args before they are logged. */
export function redactDesktopArgs(args: Record<string, unknown>): Record<string, unknown> {
	if (typeof args.text !== "string") return args;
	const { text, ...rest } = args;
	return { ...rest, textLength: (text as string).length };
}

/** The desktop tools whose `text` argument is typed into another app. */
export const DESKTOP_TEXT_TOOLS: ReadonlySet<string> = new Set(["desktop_act", "desktop_type"]);

/**
 * Args as hooks, events and the session file see them: typed text becomes
 * its length for the desktop tools; every other tool passes through as is.
 */
export function loggableToolArgs(
	toolName: string,
	args: Record<string, unknown>,
): Record<string, unknown> {
	return args && DESKTOP_TEXT_TOOLS.has(toolName) ? redactDesktopArgs(args) : args;
}

function decodedLength(body: string, levels: number): number {
	try {
		let s = body;
		for (let i = 0; i < levels; i++) s = JSON.parse(`"${s}"`) as string;
		return s.length;
	} catch {
		return body.length;
	}
}

/** "text": "..." as a model writes it in a fenced tool_call. */
const PLAIN_TEXT_ARG = /"text"(\s*):(\s*)"((?:[^"\\]|\\.)*)"/g;
/** \"text\":\"...\" when the arguments are themselves a JSON string. */
const ESCAPED_TEXT_ARG = /\\"text\\"(\s*):(\s*)\\"((?:[^"\\]|\\\\\\"|\\\\\\\\|\\\\[^"\\])*)\\"/g;
/** <parameter=text>...</parameter>, the native <tool_call> form. */
const XML_TEXT_ARG = /<parameter=text>([\s\S]*?)<\/parameter>/g;

/**
 * Typed text out of a stored message (8SO, #4057). A local model writes its
 * tool calls into the reply, so a desktop_act/desktop_type call would put the
 * typed text in the session file and replay it on --continue. In any string
 * naming one of those tools, every `text` value becomes its length.
 */
export function redactTypedText(s: string): string {
	if (!/desktop_(?:act|type)/.test(s)) return s;
	return s
		.replace(
			ESCAPED_TEXT_ARG,
			(_m, a: string, b: string, body: string) =>
				`\\"textLength\\"${a}:${b}${decodedLength(body, 2)}`,
		)
		.replace(
			PLAIN_TEXT_ARG,
			(_m, a: string, b: string, body: string) => `"textLength"${a}:${b}${decodedLength(body, 1)}`,
		)
		.replace(
			XML_TEXT_ARG,
			(_m, body: string) => `<parameter=textLength>${body.trim().length}</parameter>`,
		);
}

/** redactTypedText on every string inside a message's content. */
export function redactTypedTextInMessage<T extends { role: string; content: unknown }>(m: T): T {
	const walk = (v: unknown, depth: number): unknown => {
		if (typeof v === "string") return redactTypedText(v);
		if (depth > 32 || v === null || typeof v !== "object") return v;
		if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
		const out: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v)) out[k] = walk(x, depth + 1);
		return out;
	};
	return { ...m, content: walk(m.content, 0) };
}

/**
 * A desktop card on a plain terminal: printed to `output`, answered on
 * `input`, default NO, and nothing remembered. A closed or ended input is a
 * NO, never a hang (8SO, #4057). PermissionManager.requestPermission is not
 * used for desktop acts because it defaults to yes and caches approvals,
 * and a desktop act must be asked every time.
 */
export async function askOnTerminal(
	card: string,
	input: NodeJS.ReadableStream = process.stdin,
	output: NodeJS.WritableStream = process.stderr,
): Promise<boolean> {
	const readline = await import("node:readline");
	output.write(`\n\x1b[33m[DESKTOP CONTROL]\x1b[0m\n${card}\nAllow? [y/N]: `);
	const rl = readline.createInterface({ input, output, terminal: false });
	try {
		const answer: string | null = await new Promise((resolve) => {
			rl.once("line", resolve);
			rl.once("close", () => resolve(null));
		});
		return answer !== null && /^\s*y(es)?\s*$/i.test(answer);
	} finally {
		rl.close();
	}
}
