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

/** A string body in either quote style: group 1 double-quoted, group 2 single-quoted. */
const QUOTED = String.raw`(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')`;
/** A key: value pair at the first level, either quote style for each ("text": "..", 'Text': '..'). */
const KEY_VALUE = new RegExp(`${QUOTED}(\\s*):(\\s*)${QUOTED}`, "g");
/** The same pair when the arguments are themselves a JSON string: \"text\":\"...\". */
const BODY2 = String.raw`(?:[^"\\]|\\\\\\"|\\\\\\\\|\\\\[^"\\])*`;
const ESCAPED_KEY_VALUE = new RegExp(String.raw`\\"(${BODY2})\\"(\s*):(\s*)\\"(${BODY2})\\"`, "g");
/** text="..." / text='...', the python call form desktop_type(text="..."). */
const KWARG_TEXT = new RegExp(String.raw`\btext(\s*)=(\s*)${QUOTED}`, "gi");
/** <parameter=text>...</parameter>, the native <tool_call> form. */
const XML_TEXT_ARG = /<parameter=text>([\s\S]*?)<\/parameter>/gi;
/** Names a tool whose text is typed into another app. */
const NAMES_DESKTOP_TOOL = /desktop_(?:act|type)/i;

/** A key as the model wrote it, decoded: "Text", a \\u-escaped "text" and 'text' are all `text`. */
function isTextKey(raw: string, levels: number): boolean {
	try {
		let k = raw;
		for (let i = 0; i < levels; i++) k = JSON.parse(`"${k}"`) as string;
		return k.toLowerCase() === "text";
	} catch {
		return raw.replace(/\\(.)/g, "$1").toLowerCase() === "text";
	}
}

/** Length of a quoted body: exact for JSON, one per escape otherwise. */
function quotedLength(double: string | undefined, single: string | undefined): number {
	if (double !== undefined) return decodedLength(double, 1);
	return (single ?? "").replace(/\\(?:x[0-9a-f]{2}|u[0-9a-f]{4}|.)/gi, "_").length;
}

/**
 * Every `text` argument in a string becomes its length, in each shape a
 * model writes a call: JSON or python quotes, any key case or escape, a JSON
 * string of arguments, text="..." and <parameter=text>.
 */
function redactTextArgs(s: string): string {
	return s
		.replace(ESCAPED_KEY_VALUE, (m, key: string, a: string, b: string, body: string) =>
			isTextKey(key, 2) ? `\\"textLength\\"${a}:${b}${decodedLength(body, 2)}` : m,
		)
		.replace(
			KEY_VALUE,
			(
				m,
				kd: string | undefined,
				ks: string | undefined,
				a: string,
				b: string,
				vd?: string,
				vs?: string,
			) => {
				const q = kd !== undefined ? '"' : "'";
				return isTextKey(kd ?? ks ?? "", kd !== undefined ? 1 : 0)
					? `${q}textLength${q}${a}:${b}${quotedLength(vd, vs)}`
					: m;
			},
		)
		.replace(
			KWARG_TEXT,
			(_m, a: string, b: string, vd?: string, vs?: string) =>
				`textLength${a}=${b}${quotedLength(vd, vs)}`,
		)
		.replace(
			XML_TEXT_ARG,
			(_m, body: string) => `<parameter=textLength>${body.trim().length}</parameter>`,
		);
}

/**
 * Typed text out of a stored message (8SO, #4057). A local model writes its
 * tool calls into the reply, so a desktop_act/desktop_type call would put the
 * typed text in the session file and replay it on --continue. In any string
 * naming one of those tools, every `text` argument becomes its length.
 */
export function redactTypedText(s: string): string {
	return NAMES_DESKTOP_TOOL.test(s) ? redactTextArgs(s) : s;
}

/** The fields a structured tool-call part keeps its arguments in. */
const ARG_FIELDS = ["input", "args", "arguments", "parameters"] as const;

function isDesktopTextTool(v: Record<string, unknown>): boolean {
	return [v.toolName, v.name, v.tool].some(
		(n) => typeof n === "string" && DESKTOP_TEXT_TOOLS.has(n.toLowerCase()),
	);
}

/** `text` (any case) in an argument object becomes textLength. */
function redactArgObject(o: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, x] of Object.entries(o)) {
		if (k === "__proto__") continue;
		if (k.toLowerCase() === "text") {
			out.textLength = typeof x === "string" ? x.length : (JSON.stringify(x) ?? "").length;
		} else out[k] = x;
	}
	return out;
}

/** Arguments as an object or a JSON string; anything else gets the string rules. */
function redactArgs(v: unknown): unknown {
	if (typeof v === "string") {
		try {
			const parsed: unknown = JSON.parse(v);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return JSON.stringify(redactArgObject(parsed as Record<string, unknown>));
			}
		} catch {
			/* not JSON: fall through */
		}
		return redactTextArgs(v);
	}
	if (v && typeof v === "object" && !Array.isArray(v))
		return redactArgObject(v as Record<string, unknown>);
	return v;
}

/**
 * redactTypedText on every string inside a message's content, and for a
 * structured tool-call part naming a desktop text tool ({toolName|name|tool,
 * input|args|arguments|parameters}), the text in its arguments.
 */
export function redactTypedTextInMessage<T extends { role: string; content: unknown }>(m: T): T {
	const walk = (v: unknown, depth: number): unknown => {
		if (typeof v === "string") return redactTypedText(v);
		if (depth > 32 || v === null || typeof v !== "object") return v;
		if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
		const obj = v as Record<string, unknown>;
		const desktop = isDesktopTextTool(obj);
		const out: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(obj)) {
			if (k === "__proto__") continue;
			const field = desktop && (ARG_FIELDS as readonly string[]).includes(k) ? redactArgs(x) : x;
			out[k] = walk(field, depth + 1);
		}
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
