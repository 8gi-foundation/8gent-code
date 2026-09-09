/**
 * @8gent/voice - TTS Provider Abstraction Layer
 *
 * Pluggable TTS engine supporting multiple providers:
 * - KittenTTS (local neural TTS, Python worker). The default.
 * - Supertonic (local neural TTS, Python worker). Optional.
 * - macOS `say` command (built-in, zero deps). The fallback.
 * - ElevenLabs (future, placeholder)
 *
 * The Python engines run as ONE long-lived worker process per engine
 * (see ./tts-worker.py): the model loads once, then each utterance is a JSON
 * line in and a wav path out, played with `afplay`. Utterances queue in order
 * and `interrupt()` drops the queue and stops playback.
 *
 * Uses Bun.spawn for non-blocking subprocess management.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";
import {
	ENGINE_DEFAULT_VOICES,
	ENGINE_VOICES,
	getVoiceEngine,
	isVoiceForEngine,
} from "../settings/voice.js";
import type { TTSEngineName } from "../settings/schema.js";

// ============================================
// Types
// ============================================

export interface TTSSpeakOptions {
	voice?: string;
	/**
	 * Tab role the utterance belongs to (orchestrator / engineer / qa). When
	 * `voice` is not a voice of the active provider, the provider's default for
	 * this role is used instead, so a settings file written for another engine
	 * still yields distinct voices per tab.
	 */
	role?: string;
	/** Words per minute (macOS only) */
	rate?: number;
	/** Volume 0-1 (provider-dependent support) */
	volume?: number;
	/** Pitch base 0-100 (macOS only; lower is softer). */
	pitchBase?: number;
}

export interface TTSProcess {
	kill: () => void;
	/** Resolves with the playback exit code. 130 means interrupted. Never rejects. */
	exited: Promise<number>;
}

export type TTSProviderName = TTSEngineName | "elevenlabs";

export interface TTSProvider {
	name: string;
	speak(text: string, options?: TTSSpeakOptions): Promise<TTSProcess>;
	interrupt(): Promise<void>;
	isAvailable(): Promise<boolean>;
	voices(): string[];
	/** Human-readable reason the provider is unavailable, once known. */
	unavailableReason?(): string | null;
	/** Release long-lived resources (worker processes). */
	dispose?(): void;
}

export interface TTSEngineStatus {
	/** Engine requested by settings. */
	preferred: TTSProviderName;
	/** Engine actually speaking, or null before the first utterance resolves it. */
	active: string | null;
	/** One-line fallback note, or null when the preferred engine is active. */
	note: string | null;
	/** Synthesis time of the last utterance in ms (Python engines), else null. */
	lastSynthesisMs: number | null;
}

const INTERRUPTED_EXIT_CODE = 130;

// ============================================
// MacOS TTS Provider
// ============================================

export class MacOSTTSProvider implements TTSProvider {
	readonly name = "macos";
	private currentProcess: ReturnType<typeof Bun.spawn> | null = null;

	async speak(text: string, options?: TTSSpeakOptions): Promise<TTSProcess> {
		const voice = options?.voice ?? ENGINE_DEFAULT_VOICES.macos.fallback;
		// Strip inline `[[ ]]` speech commands from the caller's text so users
		// cannot inject them, then apply the requested modulation ourselves.
		let safe = text.replace(/\[\[[^\]]*\]\]/g, "").slice(0, 2000);
		if (typeof options?.pitchBase === "number") {
			// `[[rset 0]]` resets the voice state, `[[pbas N]]` sets the pitch
			// base. See `man say` (Speech Synthesis Manager).
			safe = `[[rset 0]] [[pbas ${Math.round(options.pitchBase)}]] ${safe}`;
		}

		const args = ["say", "-v", voice];
		if (typeof options?.rate === "number") args.push("-r", String(options.rate));
		args.push(safe);
		const proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
		this.currentProcess = proc;

		return {
			kill: () => {
				try {
					proc.kill();
				} catch {}
				this.currentProcess = null;
			},
			exited: proc.exited.then((code) => {
				if (this.currentProcess === proc) this.currentProcess = null;
				return code;
			}),
		};
	}

	async interrupt(): Promise<void> {
		if (this.currentProcess) {
			try {
				this.currentProcess.kill();
			} catch {}
			this.currentProcess = null;
		}
	}

	async isAvailable(): Promise<boolean> {
		if (process.platform !== "darwin") return false;
		try {
			const proc = Bun.spawn(["which", "say"], {
				stdout: "ignore",
				stderr: "ignore",
			});
			const code = await proc.exited;
			return code === 0;
		} catch {
			return false;
		}
	}

	unavailableReason(): string | null {
		return process.platform === "darwin" ? null : "macOS say is only available on macOS";
	}

	voices(): string[] {
		return [...ENGINE_VOICES.macos];
	}
}

// ============================================
// Python worker providers (KittenTTS, Supertonic)
// ============================================

export type PythonTTSEngine = "kitten" | "supertonic";

export interface PythonWorkerOptions {
	/** Python interpreter. Default: first candidate that can import the engine module. */
	python?: string;
	/** Path to the worker script. Default: ./tts-worker.py next to this file. */
	workerPath?: string;
	/** Player command prefix; the wav path is appended. Default: ["afplay"]. */
	player?: string[];
	/** Directory for generated wav files. Default: <tmpdir>/8gent-tts. */
	outDir?: string;
	/** How long to wait for the worker's ready line (model load). Default 120 s. */
	readyTimeoutMs?: number;
	/** How long to wait for one synthesis. Default 30 s. */
	requestTimeoutMs?: number;
	/** Extra environment for the worker and player processes (tests). */
	env?: Record<string, string>;
}

const ENGINE_MODULES: Record<PythonTTSEngine, string> = {
	kitten: "kittentts",
	supertonic: "supertonic",
};

const DEFAULT_WORKER_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"tts-worker.py",
);

function pythonCandidates(): string[] {
	const fromEnv = process.env.EIGHTGENT_TTS_PYTHON?.trim();
	const list = [
		...(fromEnv ? [fromEnv] : []),
		"python3",
		"/usr/bin/python3",
		"/opt/homebrew/bin/python3",
		"/usr/local/bin/python3",
		"python",
	];
	return [...new Set(list)];
}

interface QueuedUtterance {
	id: number;
	text: string;
	voice: string;
	cancelled: boolean;
	player: ReturnType<typeof Bun.spawn> | null;
	finish: (code: number) => void;
	exited: Promise<number>;
}

interface WorkerHandle {
	proc: Subprocess<"pipe", "pipe", "ignore">;
	pending: Map<number, { resolve: (line: WorkerResponse) => void; reject: (err: Error) => void }>;
	ready: boolean;
}

interface WorkerResponse {
	id?: number | null;
	event?: string;
	engine?: string;
	voices?: string[];
	load_ms?: number;
	path?: string;
	ms?: number;
	seconds?: number;
	error?: string;
}

/**
 * TTS provider backed by one long-lived Python worker (see tts-worker.py).
 *
 * - `isAvailable()` imports the engine module once and caches the answer.
 * - `speak()` queues the utterance; utterances play strictly in order.
 * - `interrupt()` kills the current player and drops the queue.
 * - A worker that dies is respawned on the next utterance; after three failed
 *   boots the provider reports itself unavailable so the engine falls back.
 */
export class PythonWorkerTTSProvider implements TTSProvider {
	readonly name: PythonTTSEngine;
	private readonly module: string;
	private readonly opts: Required<
		Pick<
			PythonWorkerOptions,
			"player" | "outDir" | "readyTimeoutMs" | "requestTimeoutMs" | "workerPath"
		>
	> &
		Pick<PythonWorkerOptions, "python" | "env">;
	private python: string | null = null;
	private availability: Promise<boolean> | null = null;
	private reason: string | null = null;
	private knownVoices: string[];
	private worker: WorkerHandle | null = null;
	private booting: Promise<WorkerHandle> | null = null;
	private bootFailures = 0;
	private nextId = 1;
	private queue: QueuedUtterance[] = [];
	private current: QueuedUtterance | null = null;
	private pumping = false;
	/** Stats from the last synthesis, for `/voice` and tests. */
	lastSynthesisMs: number | null = null;
	lastLoadMs: number | null = null;

	constructor(engine: PythonTTSEngine, options: PythonWorkerOptions = {}) {
		this.name = engine;
		this.module = ENGINE_MODULES[engine];
		this.knownVoices = [...ENGINE_VOICES[engine]];
		this.opts = {
			python: options.python,
			workerPath: options.workerPath ?? DEFAULT_WORKER_PATH,
			player: options.player ?? ["afplay"],
			outDir: options.outDir ?? path.join(os.tmpdir(), "8gent-tts"),
			readyTimeoutMs: options.readyTimeoutMs ?? 120_000,
			requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
			env: options.env,
		};
	}

	private spawnEnv(): Record<string, string | undefined> {
		return this.opts.env ? { ...process.env, ...this.opts.env } : process.env;
	}

	voices(): string[] {
		return [...this.knownVoices];
	}

	unavailableReason(): string | null {
		return this.reason;
	}

	async isAvailable(): Promise<boolean> {
		if (!this.availability) this.availability = this.probe();
		return this.availability;
	}

	private async probe(): Promise<boolean> {
		if (this.bootFailures >= 3) return false;
		const candidates = this.opts.python ? [this.opts.python] : pythonCandidates();
		for (const candidate of candidates) {
			try {
				const proc = Bun.spawn([candidate, "-c", `import ${this.module}`], {
					stdout: "ignore",
					stderr: "ignore",
				});
				if ((await proc.exited) === 0) {
					this.python = candidate;
					this.reason = null;
					return true;
				}
			} catch {
				// Interpreter missing; try the next candidate.
			}
		}
		this.reason = `${this.module} is not importable by ${candidates.join(", ")}`;
		return false;
	}

	async speak(text: string, options?: TTSSpeakOptions): Promise<TTSProcess> {
		const clean = text.trim().slice(0, 2000);
		if (!(await this.isAvailable())) {
			throw new Error(this.reason ?? `${this.name} TTS is unavailable`);
		}
		// Boot (or reuse) the worker before queueing so a provider that cannot
		// run rejects here and the engine can fall back for this utterance.
		// The worker's ready line is also what fixes the voice list, so resolve
		// the voice only after it.
		await this.ensureWorker();
		const requested = options?.voice?.trim();
		const voice =
			requested && this.knownVoices.includes(requested)
				? requested
				: ENGINE_DEFAULT_VOICES[this.name].fallback;

		let finish: (code: number) => void = () => {};
		const exited = new Promise<number>((resolve) => {
			finish = resolve;
		});
		const item: QueuedUtterance = {
			id: this.nextId++,
			text: clean,
			voice,
			cancelled: false,
			player: null,
			finish,
			exited,
		};
		this.queue.push(item);
		void this.pump();
		return {
			kill: () => this.cancel(item),
			exited,
		};
	}

	async interrupt(): Promise<void> {
		const dropped = this.queue.splice(0, this.queue.length);
		for (const item of dropped) this.cancel(item);
		if (this.current) this.cancel(this.current);
	}

	dispose(): void {
		void this.interrupt();
		const worker = this.worker;
		this.worker = null;
		if (worker) {
			for (const p of worker.pending.values()) p.reject(new Error("worker disposed"));
			worker.pending.clear();
			try {
				worker.proc.stdin.end();
			} catch {}
			try {
				worker.proc.kill();
			} catch {}
		}
	}

	private cancel(item: QueuedUtterance): void {
		if (item.cancelled) return;
		item.cancelled = true;
		const idx = this.queue.indexOf(item);
		if (idx >= 0) this.queue.splice(idx, 1);
		if (item.player) {
			try {
				item.player.kill();
			} catch {}
		} else if (this.current !== item) {
			item.finish(INTERRUPTED_EXIT_CODE);
		}
	}

	private async pump(): Promise<void> {
		if (this.pumping) return;
		this.pumping = true;
		try {
			while (this.queue.length > 0) {
				const item = this.queue.shift();
				if (!item) break;
				if (item.cancelled) {
					item.finish(INTERRUPTED_EXIT_CODE);
					continue;
				}
				this.current = item;
				let wav: string | null = null;
				try {
					wav = await this.synthesize(item);
				} catch {
					this.current = null;
					item.finish(1);
					continue;
				}
				if (item.cancelled) {
					this.current = null;
					this.unlink(wav);
					item.finish(INTERRUPTED_EXIT_CODE);
					continue;
				}
				let code = 1;
				try {
					const player = Bun.spawn([...this.opts.player, wav], {
						stdout: "ignore",
						stderr: "ignore",
						env: this.spawnEnv(),
					});
					item.player = player;
					code = await player.exited;
				} catch {
					code = 1;
				}
				this.current = null;
				this.unlink(wav);
				item.finish(item.cancelled ? INTERRUPTED_EXIT_CODE : code);
			}
		} finally {
			this.pumping = false;
			this.current = null;
		}
	}

	private unlink(file: string | null): void {
		if (!file) return;
		try {
			fs.unlinkSync(file);
		} catch {}
	}

	private async synthesize(item: QueuedUtterance): Promise<string> {
		const worker = await this.ensureWorker();
		const out = path.join(this.opts.outDir, `${this.name}-${process.pid}-${item.id}.wav`);
		const response = await new Promise<WorkerResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				worker.pending.delete(item.id);
				reject(new Error(`${this.name} synthesis timed out`));
			}, this.opts.requestTimeoutMs);
			worker.pending.set(item.id, {
				resolve: (line) => {
					clearTimeout(timer);
					resolve(line);
				},
				reject: (err) => {
					clearTimeout(timer);
					reject(err);
				},
			});
			const line = `${JSON.stringify({ id: item.id, text: item.text, voice: item.voice, out })}\n`;
			try {
				worker.proc.stdin.write(line);
				worker.proc.stdin.flush();
			} catch (err) {
				worker.pending.delete(item.id);
				clearTimeout(timer);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
		if (response.error || !response.path) {
			throw new Error(response.error ?? "worker returned no wav path");
		}
		this.lastSynthesisMs = response.ms ?? null;
		return response.path;
	}

	private ensureWorker(): Promise<WorkerHandle> {
		if (this.worker?.ready) return Promise.resolve(this.worker);
		if (this.booting) return this.booting;
		this.booting = this.boot().finally(() => {
			this.booting = null;
		});
		return this.booting;
	}

	private async boot(): Promise<WorkerHandle> {
		if (!this.python) {
			if (!(await this.isAvailable()) || !this.python) {
				throw new Error(this.reason ?? `${this.name} TTS is unavailable`);
			}
		}
		try {
			fs.mkdirSync(this.opts.outDir, { recursive: true });
		} catch {}

		const proc: Subprocess<"pipe", "pipe", "ignore"> = Bun.spawn(
			[this.python, "-u", this.opts.workerPath, "--engine", this.name],
			{
				stdin: "pipe",
				stdout: "pipe",
				stderr: "ignore",
				env: this.spawnEnv(),
			},
		);
		const handle: WorkerHandle = { proc, pending: new Map(), ready: false };

		let readyResolve: (r: WorkerResponse) => void = () => {};
		let readyReject: (e: Error) => void = () => {};
		const readyPromise = new Promise<WorkerResponse>((resolve, reject) => {
			readyResolve = resolve;
			readyReject = reject;
		});

		void this.readLines(handle, (msg) => {
			if (!handle.ready) {
				if (msg.event === "ready") {
					handle.ready = true;
					readyResolve(msg);
				} else if (msg.event === "error") {
					readyReject(new Error(msg.error ?? "worker failed to start"));
				}
				return;
			}
			if (typeof msg.id === "number") {
				const p = handle.pending.get(msg.id);
				if (p) {
					handle.pending.delete(msg.id);
					p.resolve(msg);
				}
			}
		}).then(() => {
			// Worker exited: fail anything still waiting and forget the handle.
			for (const p of handle.pending.values()) p.reject(new Error(`${this.name} worker exited`));
			handle.pending.clear();
			if (!handle.ready) readyReject(new Error(`${this.name} worker exited before ready`));
			if (this.worker === handle) this.worker = null;
		});

		const timer = setTimeout(() => {
			readyReject(new Error(`${this.name} worker did not become ready in ${this.opts.readyTimeoutMs} ms`));
			try {
				proc.kill();
			} catch {}
		}, this.opts.readyTimeoutMs);

		try {
			const ready = await readyPromise;
			clearTimeout(timer);
			if (Array.isArray(ready.voices) && ready.voices.length > 0) {
				this.knownVoices = ready.voices.filter((v): v is string => typeof v === "string");
			}
			this.lastLoadMs = ready.load_ms ?? null;
			this.bootFailures = 0;
			this.worker = handle;
			return handle;
		} catch (err) {
			clearTimeout(timer);
			this.bootFailures += 1;
			if (this.bootFailures >= 3) {
				this.reason = `${this.name} worker failed to start ${this.bootFailures} times: ${
					err instanceof Error ? err.message : String(err)
				}`;
				this.availability = Promise.resolve(false);
			}
			try {
				proc.kill();
			} catch {}
			throw err;
		}
	}

	private async readLines(
		handle: WorkerHandle,
		onLine: (msg: WorkerResponse) => void,
	): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			const reader = handle.proc.stdout.getReader();
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let nl = buffer.indexOf("\n");
				while (nl >= 0) {
					const line = buffer.slice(0, nl).trim();
					buffer = buffer.slice(nl + 1);
					if (line.length > 0) {
						try {
							onLine(JSON.parse(line) as WorkerResponse);
						} catch {
							// Not protocol output; ignore.
						}
					}
					nl = buffer.indexOf("\n");
				}
			}
		} catch {
			// Stream closed.
		}
		try {
			await handle.proc.exited;
		} catch {}
	}
}

export class KittenTTSProvider extends PythonWorkerTTSProvider {
	constructor(options: PythonWorkerOptions = {}) {
		super("kitten", options);
	}
}

export class SupertonicTTSProvider extends PythonWorkerTTSProvider {
	constructor(options: PythonWorkerOptions = {}) {
		super("supertonic", options);
	}
}

// ============================================
// TTSEngine: orchestrator with fallback
// ============================================

export type TTSProviderFactories = Partial<Record<TTSProviderName, () => TTSProvider>>;

export interface TTSEngineOptions {
	/** Override provider construction (tests inject fakes here). */
	providers?: TTSProviderFactories;
	/** Receives the one-line fallback note. Default appends to ~/.8gent/logs/voice.log. */
	log?: (line: string) => void;
}

const DEFAULT_PROVIDERS: Record<TTSProviderName, () => TTSProvider> = {
	macos: () => new MacOSTTSProvider(),
	kitten: () => new KittenTTSProvider(),
	supertonic: () => new SupertonicTTSProvider(),
	elevenlabs: () => {
		// Placeholder: not yet implemented
		throw new Error("ElevenLabs TTS provider not yet implemented");
	},
};

function appendVoiceLog(line: string): void {
	try {
		const dir = path.join(os.homedir(), ".8gent", "logs");
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(path.join(dir, "voice.log"), `[${new Date().toISOString()}] ${line}\n`);
	} catch {
		// Best-effort logging.
	}
}

export class TTSEngine {
	private preferred: TTSProviderName;
	private readonly factories: Record<TTSProviderName, () => TTSProvider>;
	private readonly log: (line: string) => void;
	private providerCache: Map<TTSProviderName, TTSProvider> = new Map();
	private resolvedProvider: TTSProvider | null = null;
	private resolving: Promise<TTSProvider> | null = null;
	private note: string | null = null;

	constructor(preferred: TTSProviderName = "kitten", options: TTSEngineOptions = {}) {
		this.preferred = preferred;
		this.factories = { ...DEFAULT_PROVIDERS, ...(options.providers ?? {}) };
		this.log = options.log ?? appendVoiceLog;
	}

	/**
	 * Get the active provider. Returns preferred if available, falls back to macos.
	 */
	async getProvider(): Promise<TTSProvider> {
		if (this.resolvedProvider) return this.resolvedProvider;
		if (this.resolving) return this.resolving;
		this.resolving = this.resolveProvider().finally(() => {
			this.resolving = null;
		});
		return this.resolving;
	}

	private async resolveProvider(): Promise<TTSProvider> {
		const pref = this.getOrCreateProvider(this.preferred);
		let available = false;
		try {
			available = await pref.isAvailable();
		} catch {
			available = false;
		}
		if (available) {
			this.resolvedProvider = pref;
			this.note = null;
			return pref;
		}
		if (this.preferred !== "macos") {
			const reason = pref.unavailableReason?.() ?? "not available";
			this.fallBack(`TTS engine "${this.preferred}" unavailable (${reason}); using macOS say`);
		}
		const macos = this.getOrCreateProvider("macos");
		this.resolvedProvider = macos;
		return macos;
	}

	private fallBack(note: string): void {
		if (this.note !== note) {
			this.note = note;
			try {
				this.log(note);
			} catch {}
		}
		this.resolvedProvider = this.getOrCreateProvider("macos");
	}

	private getOrCreateProvider(name: TTSProviderName): TTSProvider {
		let provider = this.providerCache.get(name);
		if (!provider) {
			try {
				provider = this.factories[name]();
			} catch {
				// Provider construction failed (e.g. elevenlabs placeholder).
				provider = name === "macos" ? new MacOSTTSProvider() : this.getOrCreateProvider("macos");
			}
			this.providerCache.set(name, provider);
		}
		return provider;
	}

	/**
	 * Pick the voice for a provider: the requested voice when the provider
	 * knows it, else the provider's default for the role, else its fallback.
	 */
	resolveVoice(provider: TTSProvider, options?: TTSSpeakOptions): string {
		const requested = options?.voice?.trim();
		const known = provider.voices();
		if (requested) {
			// macOS accepts any installed voice except leftover neural names;
			// the neural engines only know their fixed lists.
			const ok =
				provider.name === "macos"
					? isVoiceForEngine("macos", requested)
					: known.includes(requested);
			if (ok) return requested;
		}
		const defaults = ENGINE_DEFAULT_VOICES[provider.name as TTSEngineName];
		if (!defaults) return requested || known[0] || "";
		const role = options?.role;
		if (role === "orchestrator" || role === "engineer" || role === "qa") {
			return defaults[role];
		}
		return defaults.fallback;
	}

	/**
	 * Speak text using the active provider. If the provider fails to speak
	 * (worker cannot boot), fall back to macOS say for this and later
	 * utterances. Never throws for a missing engine.
	 */
	async speak(text: string, options?: TTSSpeakOptions): Promise<TTSProcess> {
		const provider = await this.getProvider();
		const voice = this.resolveVoice(provider, options);
		try {
			return await provider.speak(text, { ...options, voice });
		} catch (err) {
			if (provider.name === "macos") throw err;
			const reason = err instanceof Error ? err.message : String(err);
			this.fallBack(`TTS engine "${provider.name}" failed (${reason}); using macOS say`);
			const macos = this.getOrCreateProvider("macos");
			return macos.speak(text, { ...options, voice: this.resolveVoice(macos, options) });
		}
	}

	/**
	 * Interrupt any currently playing speech.
	 */
	async interrupt(): Promise<void> {
		const provider = await this.getProvider();
		return provider.interrupt();
	}

	/**
	 * Get the name of the active provider.
	 */
	async getProviderName(): Promise<string> {
		const provider = await this.getProvider();
		return provider.name;
	}

	/**
	 * Preferred engine, active engine (once resolved) and the fallback note.
	 */
	getStatus(): TTSEngineStatus {
		const stats = this.resolvedProvider as { lastSynthesisMs?: number | null } | null;
		return {
			preferred: this.preferred,
			active: this.resolvedProvider?.name ?? null,
			note: this.note,
			lastSynthesisMs: typeof stats?.lastSynthesisMs === "number" ? stats.lastSynthesisMs : null,
		};
	}

	/**
	 * List voices for the active provider.
	 */
	async voices(): Promise<string[]> {
		const provider = await this.getProvider();
		return provider.voices();
	}

	/**
	 * Switch preferred provider. Clears resolved cache to re-evaluate.
	 */
	setPreferred(name: TTSProviderName): void {
		this.preferred = name;
		this.resolvedProvider = null;
		this.note = null;
	}

	/** Release worker processes held by any provider. */
	dispose(): void {
		for (const provider of this.providerCache.values()) provider.dispose?.();
		this.providerCache.clear();
		this.resolvedProvider = null;
	}
}

// ============================================
// Singleton
// ============================================

let _engine: TTSEngine | null = null;

/**
 * Get the global TTS engine singleton. The preferred engine comes from
 * `voice.engine` in ~/.8gent/settings.json (default "kitten").
 */
export function getTTSEngine(): TTSEngine {
	if (!_engine) {
		let preferred: TTSProviderName = "kitten";
		try {
			preferred = getVoiceEngine();
		} catch {
			// Settings unreadable; keep the documented default.
		}
		_engine = new TTSEngine(preferred);
	}
	return _engine;
}

/**
 * Replace the global TTS engine singleton.
 */
export function setTTSEngine(engine: TTSEngine): void {
	_engine = engine;
}
