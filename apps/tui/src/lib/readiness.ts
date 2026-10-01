/**
 * Can the active tab run a turn right now? One pure answer (#3290).
 *
 * The NOW strip and the NO MODEL card both render from this result, so they
 * cannot disagree. There is no stored "ready" flag that can go stale: the
 * answer is re-derived from live facts whenever one changes (the 8 s engine
 * probe, a provider or model switch, an agent build, a failed turn). Losing
 * Ollama mid-session reads NO MODEL on the next probe, and an engine that
 * comes back reads READY again with no restart.
 *
 * Same inputs, same answer. The rules, in order:
 *  1. A provider that needs a key and has none: none, before any network.
 *  2. The last turn on this provider was refused for its key, and the
 *     provider takes a key: none.
 *  3. A local engine provider, once the first probe has landed:
 *     - its own engine reported down: none, with agent init's note when
 *       there is one, else "<engine> is not answering.";
 *     - no single engine serves it (provider not chosen yet, or one the probe
 *       does not count): none when no engine at all answers.
 *     An engine the probe did not report on is not treated as down.
 *  4. Agent init's readiness gate found the configured engine unreachable:
 *     none, even before the first probe and even if other engines are up.
 *  5. The last turn on a hosted provider could not reach it: none.
 *  6. The agent build ended not ready (its notice is the reason): none.
 *  7. The first probe has not landed, or the build is still in flight:
 *     checking. Each build attempt is time-bounded and ends in 6 or 8.
 *  8. Built for this provider and model: ready.
 *
 * A key-required provider is built only after an authenticated call succeeds
 * (OpenRouter checks /key, never the public /models), so "ready" for it means
 * the key was accepted, not merely present.
 */

import { type KeyStatus, LOCAL_ENGINE_PROVIDERS } from "./no-provider-guidance.js";

export type ReadinessState = "ready" | "checking" | "none";

export interface Readiness {
	state: ReadinessState;
	/** Why, in one short sentence. "" only when ready. */
	reason: string;
	/** The model to name in the header: the running one when ready, else "". */
	model: string;
}

export type BuildResult = { kind: "built" } | { kind: "wait"; notice: string } | { kind: "pending" };

export interface TurnError {
	kind: "auth" | "unreachable";
	/** The provider the failed turn ran on. Another provider's error is ignored. */
	provider: string;
}

export interface ReadinessInputs {
	/** The active tab's provider id. "" = not chosen yet. */
	provider: string;
	/** The model the turn would run on, as the header shows it. */
	model: string;
	/** True once the engine probe has answered at least once. */
	firstProbeLanded: boolean;
	/** The latest probe, per local engine: name to up. */
	engines: Readonly<Record<string, boolean>>;
	keyStatus: KeyStatus;
	/** Agent init's readiness-gate reason when the configured engine failed. */
	unreachable: string | null;
	build: BuildResult;
	/** The last turn's transport failure, if it ended on one. */
	turnError: TurnError | null;
}

export const CHECKING_REASON = "looking for a model";

/** The probe's engine name for each local provider, and how to say it. */
const ENGINE_FOR: Readonly<Record<string, { engine: string; label: string }>> = {
	"8gent": { engine: "ollama", label: "Ollama" },
	ollama: { engine: "ollama", label: "Ollama" },
	lmstudio: { engine: "lmstudio", label: "LM Studio" },
	"llama-server": { engine: "llama-server", label: "llama-server" },
	apfel: { engine: "apfel", label: "apfel" },
};

const none = (reason: string): Readiness => ({ state: "none", reason, model: "" });

export function deriveReadiness(i: ReadinessInputs): Readiness {
	if (i.keyStatus === "missing") return none(`${i.provider} needs an API key.`);
	const turnError = i.turnError && i.turnError.provider === i.provider ? i.turnError : null;
	// Only a provider that takes a key can refuse one.
	if (turnError?.kind === "auth" && i.keyStatus !== "not-needed") {
		return none(`${i.provider} did not accept the API key.`);
	}

	const local = LOCAL_ENGINE_PROVIDERS.has(i.provider);
	if (local && i.firstProbeLanded) {
		const mapped = ENGINE_FOR[i.provider];
		// `=== false`: an engine the probe did not report on is not down.
		if (mapped && i.engines[mapped.engine] === false) {
			return none(i.unreachable ?? `${mapped.label} is not answering.`);
		}
		// No single engine serves it: any engine answering will do.
		if (!mapped && !Object.values(i.engines).some(Boolean)) return none("No local model is answering.");
	}
	if (i.unreachable) return none(i.unreachable);
	// A local engine is the probe's to judge, every 8 s; a hosted one has no
	// probe, so its last turn is the freshest fact.
	if (!local && turnError?.kind === "unreachable") return none(`${i.provider} could not be reached.`);
	if (i.build.kind === "wait") return none(i.build.notice);
	if (!i.firstProbeLanded || i.build.kind === "pending") {
		return { state: "checking", reason: CHECKING_REASON, model: "" };
	}
	return { state: "ready", reason: "", model: i.model };
}

/**
 * The transport failure a turn ended on, read from its last message. Only
 * the agent's own failure counts: the assistant's "[Error]" reply. A tool
 * result (a `gh` 401, a web fetch that failed) or a system line is about
 * something else, never about whether the model can answer. Within that
 * reply, only a refused key or a failed connection is a readiness fact.
 */
export function classifyTurnError(
	last: { role: string; content: string } | undefined,
): TurnError["kind"] | null {
	if (!last || last.role !== "assistant" || !/^\s*\[Error\]/.test(last.content)) return null;
	const lastContent = last.content;
	if (/\b(401|403)\b|unauthori[sz]ed|invalid api key|no auth credentials|authentication/i.test(lastContent)) {
		return "auth";
	}
	if (/ECONNREFUSED|connection refused|fetch failed|unable to connect|ENOTFOUND|EHOSTUNREACH|timed out/i.test(lastContent)) {
		return "unreachable";
	}
	return null;
}

/**
 * What a finished turn means for readiness, and what to do about it now.
 * `turnError` replaces the last one (a clean turn clears it). A local engine
 * that could not be reached is re-probed at once, unless a probe is already
 * running; a hosted one has no probe, so its build is retried, which checks
 * it again.
 */
export function turnEndFacts(
	last: { role: string; content: string } | undefined,
	provider: string,
	probeInFlight: boolean,
): { turnError: TurnError | null; probeNow: boolean; retryBuild: boolean } {
	const kind = classifyTurnError(last);
	const unreachable = kind === "unreachable";
	const local = LOCAL_ENGINE_PROVIDERS.has(provider);
	return {
		turnError: kind ? { kind, provider } : null,
		probeNow: unreachable && local && !probeInFlight,
		retryBuild: unreachable && !local,
	};
}

/** What a build result was for. A result keyed for another tab or spec is "pending". */
export function readinessBuildKey(tabId: string, provider: string, model: string): string {
	return `${tabId}\u0000${provider}\u0000${model}`;
}

/** The build fact for the current key: built, waiting with its notice, or not in yet. */
export function buildResultFor(
	fact: { key: string; notice: string | null } | null,
	key: string,
): BuildResult {
	if (!fact || fact.key !== key) return { kind: "pending" };
	return fact.notice === null ? { kind: "built" } : { kind: "wait", notice: fact.notice };
}
