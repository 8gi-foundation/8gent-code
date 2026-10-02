/**
 * @8gent/render - the screenshot backend interface (#3346).
 *
 * One interface, two backends, chosen in a fixed order:
 *   1. 8gent Browser `render.*` over its loopback control socket (PR 3). Works
 *      inside the agent sandbox, because 8gent Browser already is a Chromium.
 *   2. Headless Chrome (./chrome.ts). Works outside the sandbox only.
 *
 * A session is opened once per document, then shown and captured per slide or
 * frame, then closed. Backends return PNG bytes; the caller decides where they go.
 *
 * Probe rule for every backend: `available()` must exercise the path that
 * renders (for 8gent Browser: auth, render.open of a tiny page, render.close).
 * It must never call the 8gent Browser tabs.list command, which throws on the installed
 * build. A source guard in backend.test.ts enforces that for this package.
 */

export type BackendName = "8gent-browser" | "chrome-headless";

/** Most preferred first. Selection follows this, never the order backends are passed in. */
export const BACKEND_PREFERENCE: readonly BackendName[] = ["8gent-browser", "chrome-headless"];

/** Values EIGHT_RENDER_BACKEND accepts, mapped to a backend name. */
const ENV_ALIASES: Record<string, BackendName> = {
	"8gent-browser": "8gent-browser",
	chrome: "chrome-headless",
	"chrome-headless": "chrome-headless",
};

export interface RenderSize {
	width: number;
	height: number;
}

export interface Availability {
	ok: boolean;
	/** Why not, in words James can act on. Present whenever ok is false. */
	reason?: string;
}

export interface RenderSession {
	/** Move to slide or frame k. For decks this is the slide index. */
	show(slide: number): Promise<void>;
	/** PNG bytes of what is currently shown. */
	capture(): Promise<Uint8Array>;
	/** Release everything the session holds. Safe to call more than once. */
	close(): Promise<void>;
}

export interface RenderBackend {
	readonly name: BackendName;
	available(): Promise<Availability>;
	open(htmlPath: string, size: RenderSize): Promise<RenderSession>;
}

export interface UnavailableReason {
	name: BackendName | string;
	reason: string;
}

/** Raised when no backend can render. The message names every reason, never just the last. */
export class RenderBackendUnavailableError extends Error {
	readonly reasons: UnavailableReason[];
	constructor(summary: string, reasons: UnavailableReason[] = []) {
		const detail = reasons.map((r) => `${r.name}: ${r.reason}`).join("; ");
		super(detail ? `${summary} (${detail})` : summary);
		this.name = "RenderBackendUnavailableError";
		this.reasons = reasons;
	}
}

async function probe(backend: RenderBackend): Promise<Availability> {
	try {
		const r = await backend.available();
		return r.ok ? { ok: true } : { ok: false, reason: r.reason || "unavailable, no reason given" };
	} catch (err) {
		return {
			ok: false,
			reason: `probe threw: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

/**
 * Pick the backend to render with.
 *
 * EIGHT_RENDER_BACKEND, when set, forces one backend and never falls back: a
 * forced backend that is unavailable is an error. Otherwise backends are probed
 * in BACKEND_PREFERENCE order and the first available one wins; later ones are
 * not probed. If none is available the error carries every reason.
 */
export async function selectBackend(
	backends: readonly RenderBackend[],
	env: Record<string, string | undefined> = process.env,
): Promise<RenderBackend> {
	if (backends.length === 0)
		throw new RenderBackendUnavailableError("no render backend registered");

	const forced = env.EIGHT_RENDER_BACKEND?.trim();
	if (forced) {
		const name = ENV_ALIASES[forced];
		if (!name) {
			throw new RenderBackendUnavailableError(
				`EIGHT_RENDER_BACKEND=${forced} is not a backend; use one of ${Object.keys(ENV_ALIASES).join(", ")}`,
			);
		}
		const backend = backends.find((b) => b.name === name);
		if (!backend)
			throw new RenderBackendUnavailableError(
				`EIGHT_RENDER_BACKEND=${forced}: ${name} is not registered`,
			);
		const r = await probe(backend);
		if (!r.ok) {
			throw new RenderBackendUnavailableError(`EIGHT_RENDER_BACKEND=${forced} is unavailable`, [
				{ name, reason: r.reason ?? "" },
			]);
		}
		return backend;
	}

	const rank = (b: RenderBackend) => {
		const i = BACKEND_PREFERENCE.indexOf(b.name);
		return i === -1 ? BACKEND_PREFERENCE.length : i;
	};
	const ordered = [...backends].sort((a, b) => rank(a) - rank(b));
	const reasons: UnavailableReason[] = [];
	for (const backend of ordered) {
		const r = await probe(backend);
		if (r.ok) return backend;
		reasons.push({ name: backend.name, reason: r.reason ?? "" });
	}
	throw new RenderBackendUnavailableError("no render backend is available", reasons);
}
