/**
 * tool-result-cap.ts - how much of each tool result the model is sent.
 *
 * Native tool results reached the provider whole, and every later step re-sent them.
 * Artale (Termux, MiniMax, 23 Oct): grep and sed over the installed bundle, 45 calls,
 * 6,032k tokens by step 23. One bundle line can be hundreds of KB. In a recorded run
 * (5 calls over a 16 MB bundle) the request grew from 30 KB to 838 KB and stayed there.
 *
 * Applied to the messages before every step, so it covers every tool, MCP included,
 * and results from earlier turns. The TUI still shows the full result.
 *   - No line longer than LINE_MAX characters.
 *   - The newest KEEP_RECENT results keep up to RESULT_MAX bytes, older ones OLD_RESULT_MAX.
 *   - A read inside the installed npm package gets a note saying so, once.
 * Secrets are scrubbed before any cut, so a cut never leaves half a token (#2464).
 */
import type { ModelMessage } from "ai";
import { scrub } from "../eight/secret-scanner";

export const LINE_MAX = 2000;
export const RESULT_MAX = 16 * 1024;
export const OLD_RESULT_MAX = 1024;
export const KEEP_RECENT = 6;

const INSTALLED_PACKAGE = /node_modules[\\/]@8gi-foundation[\\/]8gent-code/;

export const INSTALLED_BUILD_NOTE =
	"[Note: this path is 8gent's installed npm build. The bundle is generated and cannot be changed here. Stop reading it. Tell the user plainly that you are running from an installed build, and suggest cloning https://github.com/8gi-foundation/8gent-code to change 8gent, or filing an issue there.]";

function charSafeCut(buf: Buffer, i: number, dir: 1 | -1): number {
	while (i > 0 && i < buf.length && (buf[i] & 0xc0) === 0x80) i += dir;
	return i;
}

/** Shorten every line over LINE_MAX characters, saying how much went. */
export function capLines(text: string, max = LINE_MAX): string {
	if (text.length <= max) return text;
	let changed = false;
	const lines = text.split("\n").map((line) => {
		if (line.length <= max) return line;
		changed = true;
		return `${line.slice(0, max)} [${line.length - max} chars cut from this line]`;
	});
	return changed ? lines.join("\n") : text;
}

/** Keep the head and tail of text so it fits in maxBytes, with a note of what went. */
export function capBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	const buf = Buffer.from(scrub(text).scrubbed);
	if (buf.length <= maxBytes) return buf.toString();
	const half = Math.floor(maxBytes / 2);
	const headEnd = charSafeCut(buf, half, -1);
	const tailStart = charSafeCut(buf, buf.length - half, 1);
	return `${buf.subarray(0, headEnd)}\n[truncated ${tailStart - headEnd} bytes; narrow the command (smaller range, grep -o, cut -c) to see them]\n${buf.subarray(tailStart)}`;
}

/** Scrub first, on every result, so no cut leaves part of a secret behind (8SO, #4801). */
export function capToolText(text: string, maxBytes: number): string {
	return capBytes(capLines(scrub(text).scrubbed), maxBytes);
}

type Output = { type: string; value?: unknown };

function capOutput(output: Output, maxBytes: number, note: string | null): Output {
	const prefix = note ? `${note}\n` : "";
	if (output.type === "text" || output.type === "error-text") {
		const value = String(output.value ?? "");
		const capped = prefix + capToolText(value, maxBytes);
		return capped === value ? output : { ...output, value: capped };
	}
	if (output.type === "json" || output.type === "error-json") {
		const raw = JSON.stringify(output.value) ?? "";
		if (!note && Buffer.byteLength(raw) <= maxBytes && raw.length <= LINE_MAX) return output;
		const type = output.type === "json" ? "text" : "error-text";
		return { type, value: prefix + capToolText(raw, maxBytes) };
	}
	return output;
}

/**
 * The messages with every tool result capped. Returns the same array when nothing
 * needed cutting, so a caller can tell whether to replace the step's messages.
 */
export function capToolResults(messages: ModelMessage[]): ModelMessage[] {
	const installedCalls = new Set<string>();
	let resultCount = 0;
	for (const m of messages) {
		if (!Array.isArray(m.content)) continue;
		for (const part of m.content as Array<Record<string, unknown>>) {
			if (part.type === "tool-call" && INSTALLED_PACKAGE.test(JSON.stringify(part.input ?? "")))
				installedCalls.add(String(part.toolCallId));
			if (part.type === "tool-result") resultCount++;
		}
	}
	let seen = 0;
	let noted = false;
	let changed = false;
	const out = messages.map((m) => {
		if (m.role !== "tool" || !Array.isArray(m.content)) return m;
		let partChanged = false;
		const content = m.content.map((part) => {
			if (part.type !== "tool-result") return part;
			seen++;
			const recent = resultCount - seen < KEEP_RECENT;
			const note = !noted && installedCalls.has(part.toolCallId) ? INSTALLED_BUILD_NOTE : null;
			if (note) noted = true;
			const output = capOutput(part.output as Output, recent ? RESULT_MAX : OLD_RESULT_MAX, note);
			if (output === part.output) return part;
			partChanged = true;
			return { ...part, output } as typeof part;
		});
		if (!partChanged) return m;
		changed = true;
		return { ...m, content } as ModelMessage;
	});
	return changed ? out : messages;
}
