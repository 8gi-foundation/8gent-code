/**
 * Model residency broker (#3430). Behind EIGHT_RESIDENCY=1, default off.
 *
 * On a small machine the listener (speech-to-text), the thinker (the Ollama
 * language model) and the speaker (text-to-speech) should take turns in
 * memory instead of all staying resident. Before each phase of a voice turn
 * the broker unloads the residents that do not own that phase.
 *
 * Rules:
 * - An unload or claim failure or hang never blocks the turn (each one is
 *   caught and raced against a timeout).
 * - The broker never loads a model. A model loads itself on first use (Ollama
 *   on request, whisper.cpp and TTS per process); the broker only records
 *   which kind now holds memory.
 * - The Ollama resident unloads only the models this turn's think step used
 *   (see `ollamaTurnResident`), never everything Ollama holds.
 * - A live voice turn hints thinking off (`VoiceTurnHint` in voice-chat.ts).
 */

import { resolveOllamaBaseUrl } from "../ai/text-tool-endpoint";
import { unloadOllamaModel } from "./local-model-detect";

export type ResidentKind = "stt" | "llm" | "tts";
export type VoicePhase = "listen" | "think" | "speak";

/** Which model kind owns memory during each phase of a voice turn. */
export const PHASE_OWNER: Record<VoicePhase, ResidentKind> = {
	listen: "stt",
	think: "llm",
	speak: "tts",
};

export interface Resident {
	kind: ResidentKind;
	/** Frees the model's memory. Expected to be best-effort. */
	unload: () => Promise<void>;
	/** Runs when this kind takes the phase it owns, e.g. a snapshot before think. */
	claim?: () => Promise<void>;
	/** Whether it is resident now. Defaults to true (assume loaded). */
	resident?: boolean;
}

export interface ResidencyBrokerOptions {
	/** Max wait for one unload or claim before the turn moves on (ms, default 2000). */
	unloadTimeoutMs?: number;
	/** Observer for tests and logs: "unload:llm", "load:stt", "unload-failed:llm". */
	onEvent?: (event: string) => void;
}

export function residencyEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return env.EIGHT_RESIDENCY === "1";
}

export class ResidencyBroker {
	private residents = new Map<ResidentKind, Resident & { resident: boolean }>();
	private timeoutMs: number;
	private onEvent: (event: string) => void;

	constructor(residents: Resident[], opts: ResidencyBrokerOptions = {}) {
		for (const r of residents) this.residents.set(r.kind, { ...r, resident: r.resident ?? true });
		this.timeoutMs = opts.unloadTimeoutMs ?? 2000;
		this.onEvent = opts.onEvent ?? (() => {});
	}

	isResident(kind: ResidentKind): boolean {
		return this.residents.get(kind)?.resident ?? false;
	}

	/** Unload every resident that does not own `phase`, then record the owner as resident. */
	async enter(phase: VoicePhase): Promise<void> {
		const owner = PHASE_OWNER[phase];
		for (const r of this.residents.values()) {
			if (r.kind === owner || !r.resident) continue;
			this.onEvent(`unload:${r.kind}`);
			const ok = await this.bounded(r.unload);
			// Mark it gone either way, so one dead endpoint cannot stall every phase.
			r.resident = false;
			if (!ok) this.onEvent(`unload-failed:${r.kind}`);
		}
		const own = this.residents.get(owner);
		if (own) {
			own.resident = true;
			if (own.claim && !(await this.bounded(own.claim))) this.onEvent(`claim-failed:${owner}`);
		}
		this.onEvent(`load:${owner}`);
	}

	private async bounded(fn: () => Promise<void>): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), this.timeoutMs);
			(timer as { unref?: () => void }).unref?.();
		});
		const attempt = Promise.resolve()
			.then(fn)
			.then(
				() => true,
				() => false,
			);
		try {
			return await Promise.race([attempt, timeout]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
}

/** True only for 127.0.0.0/8, ::1 and localhost. Anything unparsable is false. */
export function isLoopbackUrl(url: string): boolean {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (host === "localhost" || host === "[::1]" || host === "::1") return true;
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * The Ollama language model as a resident, scoped to one voice turn.
 * `claim` (before think) snapshots GET /api/ps. `unload` (before speak)
 * unloads, through `unloadOllamaModel`, only the models whose entry changed
 * since that snapshot: newly loaded, or `expires_at` moved because a request
 * reached them. That is the agent model and anything the think step called,
 * such as a critic. Models nobody touched during think stay loaded.
 *
 * Fails safe: a snapshot that errors, is not HTTP 2xx, or has no `models`
 * array leaves no snapshot, and without a snapshot nothing is unloaded. A
 * non-loopback Ollama (remote OLLAMA_HOST / OLLAMA_BASE_URL) is never
 * contacted: unloading there frees no local memory and evicts other people's
 * models. Known limit: a model another session used during the same think
 * step looks the same and is unloaded too.
 */
export function ollamaTurnResident(
	baseUrl?: string,
	timeoutMs = 2000,
	warn: (message: string) => void = console.warn,
): Resident {
	const root = () => baseUrl ?? resolveOllamaBaseUrl();
	let before: Map<string, string> | null = null;
	let warned = false;
	const local = (): boolean => {
		if (isLoopbackUrl(root())) return true;
		if (!warned) {
			warned = true;
			warn("[residency] Ollama is not on this machine, so voice turns will not unload its models.");
		}
		return false;
	};
	const ps = async (): Promise<Map<string, string>> => {
		const res = await fetch(`${root()}/api/ps`, { signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) throw new Error(`ollama /api/ps returned ${res.status}`);
		const body = (await res.json()) as { models?: unknown };
		if (!Array.isArray(body?.models)) throw new Error("ollama /api/ps returned no models array");
		const out = new Map<string, string>();
		for (const m of body.models as Array<{ name?: string; model?: string; expires_at?: string }>) {
			const id = m?.model ?? m?.name;
			if (id) out.set(id, m.expires_at ?? "");
		}
		return out;
	};
	return {
		kind: "llm",
		claim: async () => {
			before = null;
			if (!local()) return;
			before = await ps();
		},
		unload: async () => {
			const snap = before;
			before = null;
			if (!snap || !local()) return;
			for (const [id, expires] of await ps()) {
				if (snap.get(id) !== expires) await unloadOllamaModel(id, root());
			}
		},
	};
}
