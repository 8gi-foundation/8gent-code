/**
 * Model residency broker (#3430). Behind EIGHT_RESIDENCY=1, default off.
 *
 * On a small machine the listener (speech-to-text), the thinker (the Ollama
 * language model) and the speaker (text-to-speech) should take turns in
 * memory instead of all staying resident. Before each phase of a voice turn
 * the broker unloads every idle model that does not own that phase.
 *
 * Rules:
 * - An unload failure or hang never blocks the turn (each one is caught and
 *   raced against a timeout).
 * - A busy model is never evicted.
 * - The broker never loads a model. A model loads itself on first use (Ollama
 *   on request, whisper.cpp and TTS per process); the broker only records
 *   which kind now holds memory.
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
	/** Whether it is resident now. Defaults to true (assume loaded). */
	resident?: boolean;
}

export interface ResidencyBrokerOptions {
	/** Max wait for one unload before the turn moves on (ms, default 2000). */
	unloadTimeoutMs?: number;
	/** Observer for tests and logs: "unload:llm", "load:stt", "unload-failed:llm". */
	onEvent?: (event: string) => void;
}

export function residencyEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return env.EIGHT_RESIDENCY === "1";
}

export class ResidencyBroker {
	private residents = new Map<ResidentKind, Resident & { resident: boolean }>();
	private busy = new Set<ResidentKind>();
	private timeoutMs: number;
	private onEvent: (event: string) => void;

	constructor(residents: Resident[], opts: ResidencyBrokerOptions = {}) {
		for (const r of residents) this.residents.set(r.kind, { ...r, resident: r.resident ?? true });
		this.timeoutMs = opts.unloadTimeoutMs ?? 2000;
		this.onEvent = opts.onEvent ?? (() => {});
	}

	/** Mark a kind busy (never evicted) or idle again. */
	setBusy(kind: ResidentKind, busy: boolean): void {
		if (busy) this.busy.add(kind);
		else this.busy.delete(kind);
	}

	isResident(kind: ResidentKind): boolean {
		return this.residents.get(kind)?.resident ?? false;
	}

	/** Unload every idle resident that does not own `phase`, then record the owner as resident. */
	async enter(phase: VoicePhase): Promise<void> {
		const owner = PHASE_OWNER[phase];
		for (const r of this.residents.values()) {
			if (r.kind === owner || !r.resident || this.busy.has(r.kind)) continue;
			this.onEvent(`unload:${r.kind}`);
			const ok = await this.boundedUnload(r);
			// Mark it gone either way: a failed unload is retried next phase only
			// if a caller re-marks it resident, so one dead endpoint cannot stall
			// every phase of every turn.
			r.resident = false;
			if (!ok) this.onEvent(`unload-failed:${r.kind}`);
		}
		const own = this.residents.get(owner);
		if (own) own.resident = true;
		this.onEvent(`load:${owner}`);
	}

	private async boundedUnload(r: Resident): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), this.timeoutMs);
			(timer as { unref?: () => void }).unref?.();
		});
		const attempt = r.unload().then(
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

/**
 * The Ollama language model as a resident: unloads every model Ollama holds
 * (GET /api/ps), reusing `unloadOllamaModel` for each. Best-effort.
 */
export function ollamaResident(baseUrl?: string, timeoutMs = 2000): Resident {
	return {
		kind: "llm",
		unload: async () => {
			const root = baseUrl ?? resolveOllamaBaseUrl();
			const res = await fetch(`${root}/api/ps`, { signal: AbortSignal.timeout(timeoutMs) });
			const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
			for (const m of body.models ?? []) {
				const id = m.model ?? m.name;
				if (id) await unloadOllamaModel(id, root);
			}
		},
	};
}
