/**
 * Deterministic offline MOCK backend. For tests and explicit selection only.
 *
 * It does not understand anything. It scores word overlap between the
 * state and the question text (noul) or each option / level (choice,
 * score) and turns the overlap into a distribution. Same input, same
 * output, no network. Never selected by auto-detection.
 */

import {
	type Answer,
	type DecideBackend,
	type Question,
	type SystemOneRequest,
	type SystemOneResponse,
	answerFromDistribution,
	renormalise,
	validateRequest,
} from "../types";

export function words(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((w) => w.length > 2),
	);
}

/** Fraction of `target` words that also appear in `state` (0..1). */
export function overlap(state: Set<string>, target: Set<string>): number {
	if (target.size === 0) return 0;
	let hit = 0;
	for (const w of target) if (state.has(w)) hit++;
	return hit / target.size;
}

export function mockDistribution(state: string, question: Question): number[] {
	const s = words(state);
	if (question.kind === "noul") {
		const yes = 0.1 + 0.8 * overlap(s, words(question.prompt));
		return [yes, 1 - yes];
	}
	const slots = question.kind === "choice" ? question.options : question.levels;
	// Softmax-ish: a floor so every slot keeps some mass, plus overlap.
	return renormalise(slots.map((slot) => 0.05 + overlap(s, words(slot))));
}

export class MockBackend implements DecideBackend {
	readonly name = "mock";
	readonly model = "mock-word-overlap";

	async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
		validateRequest(request);
		const answers: Answer[] = request.questions.map((q) => answerFromDistribution(q, mockDistribution(request.state, q)));
		return { answers, backend: this.name, model: this.model, latencyMs: 0 };
	}
}
