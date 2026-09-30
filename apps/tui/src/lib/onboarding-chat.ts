/**
 * First-run setup, asked in the chat (intro audit nit 10).
 *
 * The HUD shell draws setup as chat: each question is a message, the input
 * below it takes the answer. The old full-screen OnboardingScreen, which drew
 * select lists and ran the provider probe, is not part of this shell, so
 * after the welcome nothing else was shown: answers were stored, but the
 * next question never appeared, the welcome's single "Continue" choice could
 * not be taken with Enter, and a typed answer was not echoed.
 *
 * These pure helpers give each question its chat text, its placeholder, and
 * turn what was typed into the answer the question's processor expects.
 * An empty echo means nothing is shown as the person's message.
 */

export interface ChatQuestion {
	question: string;
	kind?: "text" | "select" | "providerCheck" | "agentName";
	choices?: Array<{ label: string; value: string; description?: string }>;
	placeholder?: string;
	default?: string;
}

/** The question as a chat message. Select steps list their choices, numbered. */
export function questionForChat(q: ChatQuestion): string {
	if (q.kind !== "select" || !q.choices || q.choices.length <= 1) return q.question;
	const labelWidth = Math.max(...q.choices.map((c) => c.label.length));
	const lines = q.choices.map((c, i) => {
		const n = String(i + 1).padStart(String(q.choices!.length).length, " ");
		const desc = c.description ? `  ${c.description}` : "";
		return `  ${n}  ${c.label.padEnd(labelWidth)}${desc}`.trimEnd();
	});
	return `${q.question}\n\n${lines.join("\n")}`;
}

/** What the input says while this question waits. */
export function placeholderFor(q: ChatQuestion): string {
	if (q.placeholder) return q.placeholder;
	if (q.kind === "select" && q.choices && q.choices.length > 0) {
		if (q.choices.length === 1)
			return `Enter to ${q.choices[0].label.replace(/^Press Enter to /i, "").toLowerCase()}`;
		return `A number, or Enter for ${q.choices[0].label}`;
	}
	if (q.kind === "agentName" && q.default) return `A name, or Enter to keep ${q.default}`;
	return "Your answer, or Enter to skip";
}

/**
 * Map typed text to the value the step's processor reads, plus what to echo
 * as the user's message. Select steps take a number, a label or a value; an
 * empty Enter takes the first choice. Other steps pass the text through, and
 * their processors keep a default for an empty answer.
 */
export function answerFromInput(q: ChatQuestion, input: string): { value: string; echo: string } {
	const text = input.trim();
	if (q.kind === "select" && q.choices && q.choices.length > 0) {
		// A one-choice step ("Press Enter to begin") is a step, not an answer:
		// nothing is echoed as if the person had said it.
		if (q.choices.length === 1 && (!text || /^(?:ok|yes|y)$/i.test(text))) {
			return { value: q.choices[0].value, echo: "" };
		}
		if (!text) return { value: q.choices[0].value, echo: q.choices[0].label };
		const n = /^\d+$/.test(text) ? Number(text) : Number.NaN;
		if (n >= 1 && n <= q.choices.length) {
			const c = q.choices[n - 1];
			return { value: c.value, echo: c.label };
		}
		const lower = text.toLowerCase();
		const hit = q.choices.find(
			(c) => c.label.toLowerCase() === lower || c.value.toLowerCase() === lower,
		);
		if (hit) return { value: hit.value, echo: hit.label };
		return { value: text, echo: text };
	}
	if (!text && q.kind === "agentName" && q.default) return { value: "", echo: q.default };
	return { value: text, echo: text || "(skipped)" };
}

/** One line for a provider the setup checked by itself instead of asking. */
export function providerCheckLine(name: string, live: boolean, installHint?: string): string {
	if (live) return `${name} is running.`;
	return installHint ? `${name} is not running. ${installHint}` : `${name} is not running.`;
}

/**
 * Setup is over: nothing in the transcript may still ask for setup input
 * (#3090). The transcript keeps conversation; a prompt nobody can answer
 * any more is stale status.
 */

/** The quiet hint under the welcome card. */
export const SETUP_SKIP_HINT = "/skip skips a question. /skip all skips the setup.";
/** The welcome's call to action. Pinned to the real copy by a test. */
export const SETUP_WELCOME_PROMPT = "A short setup follows, so I can serve you properly. Press Enter to begin.";
/** Id prefix of the welcome card, so it can be told from later questions. */
export const SETUP_WELCOME_ID = "setup-q-welcome-";
const SETUP_CARD_ID = "setup-q-";

/** A setup card's text without the call to action and the skip hint. */
export function settledSetupCard(content: string): string {
	return content
		.split(SETUP_SKIP_HINT)
		.join("")
		.split(SETUP_WELCOME_PROMPT)
		.join("")
		.replace(/\s+$/, "");
}

/**
 * The transcript once setup has ended. Every setup card loses its call to
 * action and skip hint; the greeting and what was found on the machine stay.
 * When setup ended on a /skip, the card that was still waiting for an answer
 * is an unanswered question, so it goes, unless it is the welcome, whose
 * greeting is conversation.
 */
export function settleSetupTranscript<M extends { id: string; content: string }>(
	messages: M[],
	endedBySkip: boolean,
): M[] {
	let pending = -1;
	if (endedBySkip) {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].id.startsWith(SETUP_CARD_ID)) {
				pending = messages[i].id.startsWith(SETUP_WELCOME_ID) ? -1 : i;
				break;
			}
		}
	}
	const out: M[] = [];
	messages.forEach((m, i) => {
		if (i === pending) return;
		if (!m.id.startsWith(SETUP_CARD_ID)) {
			out.push(m);
			return;
		}
		const content = settledSetupCard(m.content);
		out.push(content === m.content ? m : { ...m, content });
	});
	return out;
}
