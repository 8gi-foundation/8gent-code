/**
 * First sentence of every refused run_command (#4238). The local model reads only that
 * sentence, and a bare "[BLOCKED] Semicolon ..." once read as "the file is missing".
 */
export const REFUSAL_NOTE = "Not run: refused by policy, nothing was checked or changed.";
export const REFUSAL_LEAD = `[BLOCKED] ${REFUSAL_NOTE}`;

/** Opens every sanitizer chaining refusal (shell-sanitizer.ts): the exact remedy. */
const REMEDY = "Send each command as its own run_command call.";
/** Opens every sanitizer heredoc / multi-line write refusal (#4533). */
const WRITE_REMEDY = "Use the write_file tool to create or change a file.";

/** A refusal tag the model sees first: the sanitizer's [BLOCKED] or a backstop's [PERMISSION DENIED]. */
const REFUSAL_TAG = /^\[(BLOCKED|PERMISSION DENIED)\]\s*/;

export function refusalLead(result: string): string {
	const text = result.trimStart();
	const tag = REFUSAL_TAG.exec(text);
	if (!tag) return result;
	const body = text.slice(tag[0].length);
	if (body.startsWith("Not run:")) return result;
	const lead = `[${tag[1]}] ${REFUSAL_NOTE}`;
	const remedied = body.startsWith(REMEDY) || body.startsWith(WRITE_REMEDY);
	if (!remedied && !/chaining/i.test(body)) return `${lead} ${body}`;
	const at = body.indexOf(" Command:");
	const [why, cmd] = at < 0 ? [body, ""] : [body.slice(0, at), body.slice(at)];
	// The remedy is the first sentence the model reads: the chaining or the write_file one.
	if (remedied && why.includes(REFUSAL_NOTE)) return result;
	if (remedied) return `[${tag[1]}] ${why.replace(/\.+$/, "")}. ${REFUSAL_NOTE}${cmd}`;
	return `${lead} ${why} Run one command at a time.${cmd}`;
}
