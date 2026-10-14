/**
 * First sentence of every refused run_command (#4238). The local model reads only that
 * sentence, and a bare "[BLOCKED] Semicolon ..." once read as "the file is missing".
 */
export const REFUSAL_NOTE = "Not run: refused by policy, nothing was checked or changed.";
export const REFUSAL_LEAD = `[BLOCKED] ${REFUSAL_NOTE}`;

/** A refusal tag the model sees first: the sanitizer's [BLOCKED] or a backstop's [PERMISSION DENIED]. */
const REFUSAL_TAG = /^\[(BLOCKED|PERMISSION DENIED)\]\s*/;

export function refusalLead(result: string): string {
	const text = result.trimStart();
	const tag = REFUSAL_TAG.exec(text);
	if (!tag) return result;
	const body = text.slice(tag[0].length);
	if (body.startsWith("Not run:")) return result;
	const lead = `[${tag[1]}] ${REFUSAL_NOTE}`;
	if (!/chaining/i.test(body)) return `${lead} ${body}`;
	const at = body.indexOf(" Command:");
	const [why, cmd] = at < 0 ? [body, ""] : [body.slice(0, at), body.slice(at)];
	return `${lead} ${why} Run one command at a time.${cmd}`;
}
