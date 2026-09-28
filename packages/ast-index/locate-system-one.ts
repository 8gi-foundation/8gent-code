/**
 * System One routing for prose locate queries (Jev level 5, with the level 4
 * confidence gate).
 *
 * Flag: env EIGHT_SYSTEM_ONE_LOCATE=1 (or "true"). OFF by default. With the
 * flag off nothing here imports @8gent/decide or builds a decider, and locate
 * behaves exactly as the rules alone decide.
 *
 * With the flag on, a query the rules could not route (rule "prose": no
 * path, no identifier, no quoted text) is sent to System One as one `choice`
 * question whose five options stand for symbol, grep, path, semantic and
 * hybrid. Code, not the model, decides whether to use the answer: the
 * model's mode is kept only when its probability is at or above the
 * threshold in
 * packages/decide/calibration/locate/<backend>-<model>.json. Everything else
 * is hybrid, which is what locate does without a model:
 *
 *   below threshold -> hybrid
 *   uncalibrated    -> hybrid (the model is not asked)
 *   untrusted       -> hybrid (the model is not asked): its calibration's
 *                      held-out accuracy is under 85%. On 2026-09-28 every
 *                      model measured was, so the flag changes no answer yet.
 *   timeout         -> hybrid (default 500 ms, env EIGHT_SYSTEM_ONE_LOCATE_TIMEOUT_MS)
 *   any error       -> hybrid
 *
 * This is routing only. It never decides whether anything is safe, so it
 * fails open.
 *
 * Model: env EIGHT_SYSTEM_ONE_LOCATE_MODEL, else the decide package's own
 * choice (EIGHT_DECIDE_MODEL, then auto-detection). Only a model whose
 * locate calibration file clears the bar is ever asked.
 */

import type { Decider } from "../decide/index";
import type { LocateModeChoice } from "../decide/locate-calibration";

export const LOCATE_SYSTEM_ONE_FLAG = "EIGHT_SYSTEM_ONE_LOCATE";
export const LOCATE_SYSTEM_ONE_TIMEOUT_ENV = "EIGHT_SYSTEM_ONE_LOCATE_TIMEOUT_MS";
export const LOCATE_SYSTEM_ONE_MODEL_ENV = "EIGHT_SYSTEM_ONE_LOCATE_MODEL";
/** Routing budget per query. Over it, locate answers with hybrid. */
export const DEFAULT_LOCATE_ROUTE_TIMEOUT_MS = 500;
/**
 * Budget the backend request itself gets. Longer than the routing budget on
 * purpose: a first call that loads the model times out for routing, but the
 * load carries on, so the next query finds the model warm.
 */
const BACKEND_TIMEOUT_MS = 30_000;

/** The modes, in the order they are offered. Must match LOCATE_MODES in decide/locate-calibration.ts. */
export const LOCATE_MODE_OPTIONS: LocateModeChoice[] = [
	"symbol",
	"grep",
	"path",
	"semantic",
	"hybrid",
];

/**
 * What the model reads for each mode, same order. Plain descriptions, not
 * the mode names: with bare names as the options, the 1B and 3B models tried
 * on 2026-09-28 put their argmax on one letter for 35 to 40 of 40 queries
 * (see the decide README, "Locate mode routing"). Changing this text or the
 * question invalidates every locate calibration file.
 */
export const LOCATE_MODE_OPTION_TEXT = [
	"a named function, class, type or constant",
	"a line of text: a message, comment, setting or value",
	"a file or folder",
	"a behaviour described without the words the code uses",
	"a short phrase that could be any of these",
];

export const LOCATE_MODE_QUESTION =
	"A developer typed this query to find something in a code repository. What is the query asking for?";

/** The state the question is asked about. Shared with the eval so both ask the same thing. */
export function locateModeState(query: string): string {
	return `Query: ${query}`;
}

export type ProseRoutingReason =
	| "model"
	| "below_threshold"
	| "uncalibrated"
	| "untrusted"
	| "timeout"
	| "error";

export interface ProseRouting {
	/** The mode locate should use. */
	mode: LocateModeChoice;
	reason: ProseRoutingReason;
	/** The model's most probable mode, when it answered. */
	chosen?: LocateModeChoice;
	confidence?: number;
	probabilities?: number[];
	threshold?: number;
	backend?: string;
	model?: string;
	/** Wall time of the routing call, ms. */
	latencyMs: number;
	error?: string;
}

export type ProseRouter = (query: string) => Promise<ProseRouting>;

export interface ProseRouterOptions {
	decider: Decider | (() => Decider | Promise<Decider>);
	/** Routing budget, ms. Default 500. */
	timeoutMs?: number;
	/** Where locate calibration files live. Default packages/decide/calibration/locate. */
	calibrationDir?: string;
	/** A fixed threshold instead of the calibration file (eval and tests). */
	threshold?: number;
}

export function locateSystemOneEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	const v = (env[LOCATE_SYSTEM_ONE_FLAG] || "").trim().toLowerCase();
	return v === "1" || v === "true";
}

export function locateRouteTimeoutMs(
	env: Record<string, string | undefined> = process.env,
): number {
	const raw = Number((env[LOCATE_SYSTEM_ONE_TIMEOUT_ENV] ?? "").trim());
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LOCATE_ROUTE_TIMEOUT_MS;
}

class RouteTimeout extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new RouteTimeout(`no answer within ${ms} ms`)), ms);
	});
	// The losing promise settles on its own; a late rejection must not surface.
	work.catch(() => {});
	return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Ask System One which mode fits `query`, and gate the answer in code. Never throws. */
export function createProseRouter(opts: ProseRouterOptions): ProseRouter {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCATE_ROUTE_TIMEOUT_MS;
	// Per (backend, model): the calibrated threshold, or why there is none.
	const thresholds = new Map<string, number | "uncalibrated" | "untrusted">();
	return async (query) => {
		const t0 = performance.now();
		const ms = () => Math.round(performance.now() - t0);
		const seen: Partial<ProseRouting> = {};
		const work = (async (): Promise<ProseRouting> => {
			const { gateMode, loadLocateCalibration, locateCalibrationTrusted } = await import(
				"../decide/locate-calibration"
			);
			const decider = typeof opts.decider === "function" ? await opts.decider() : opts.decider;
			const backend = await decider.backend();
			seen.backend = backend.name;
			seen.model = backend.model;
			let threshold = opts.threshold;
			if (threshold === undefined) {
				const key = JSON.stringify([backend.name, backend.model]);
				let gate = thresholds.get(key);
				if (!gate) {
					const cal = opts.calibrationDir
						? loadLocateCalibration(backend.model, backend.name, opts.calibrationDir)
						: loadLocateCalibration(backend.model, backend.name);
					gate = !cal
						? "uncalibrated"
						: locateCalibrationTrusted(cal)
							? cal.threshold
							: "untrusted";
					thresholds.set(key, gate);
				}
				if (typeof gate === "string")
					return { ...seen, mode: "hybrid", reason: gate, latencyMs: ms() };
				threshold = gate;
			}
			const answer = await decider.choice(locateModeState(query), LOCATE_MODE_QUESTION, [
				...LOCATE_MODE_OPTION_TEXT,
			]);
			const chosen = LOCATE_MODE_OPTIONS[answer.chosen];
			const mode = chosen ? gateMode(chosen, answer.confidence, threshold) : "hybrid";
			return {
				...seen,
				mode,
				reason:
					chosen &&
					mode === chosen &&
					Number.isFinite(answer.confidence) &&
					answer.confidence >= threshold
						? "model"
						: "below_threshold",
				...(chosen ? { chosen } : {}),
				confidence: answer.confidence,
				probabilities: answer.probabilities,
				threshold,
				latencyMs: ms(),
			};
		})();
		try {
			return await withTimeout(work, timeoutMs);
		} catch (err) {
			const timeout = err instanceof RouteTimeout;
			return {
				...seen,
				mode: "hybrid",
				reason: timeout ? "timeout" : "error",
				latencyMs: ms(),
				...(timeout ? {} : { error: err instanceof Error ? err.message : String(err) }),
			};
		}
	};
}

let processDecider: Promise<Decider> | null = null;
let processRouter: ProseRouter | null = null;

/** Test-only: forget the process decider and router. */
export function _resetLocateSystemOne(): void {
	processDecider = null;
	processRouter = null;
}

function getDecider(env: Record<string, string | undefined>): Promise<Decider> {
	if (!processDecider) {
		processDecider = (async () => {
			const { createDecider } = await import("../decide/index");
			const model = env[LOCATE_SYSTEM_ONE_MODEL_ENV]?.trim() || undefined;
			return createDecider({ model, timeoutMs: BACKEND_TIMEOUT_MS });
		})();
		// A failed construction must not stick; the next query retries.
		processDecider.catch(() => {
			processDecider = null;
		});
	}
	return processDecider;
}

/** The process router when the flag is on, else null. One decider per process, built on first use. */
export function defaultProseRouter(
	env: Record<string, string | undefined> = process.env,
): ProseRouter | null {
	if (!locateSystemOneEnabled(env)) return null;
	if (!processRouter) {
		processRouter = createProseRouter({
			decider: () => getDecider(env),
			timeoutMs: locateRouteTimeoutMs(env),
		});
	}
	return processRouter;
}
