/**
 * Model ledger (#4609): which local model is actually answering.
 *
 * On session start the identity of the local model in use (provider, name,
 * quantisation, content digest) is read from the provider's own API and pinned
 * on first use in ~/.8gent/model-ledger.json. Later sessions compare against
 * the pin and say so, plainly, when the digest or quantisation behind the same
 * name changed, so a model cannot be silently swapped or re-quantised under
 * the user. Cloud providers record provider and model id only.
 *
 * Names, quantisations and digests all come from the live server; nothing here
 * names a model. The ledger holds identity only, never prompt text. Never
 * blocks and never throws: an unreachable provider is a plain note.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveHome } from "../core/home";
import { resolveOllamaBaseUrl } from "./ollama-host";
import { resolveLlamaServerUrl } from "./select";

type Env = Record<string, string | undefined>;
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ModelPin {
	provider: string;
	model: string;
	/** Set for cloud providers: only provider and model id are recorded. */
	cloud?: boolean;
	digest?: string;
	quant?: string;
	size?: string;
	/** ISO time this identity was pinned. */
	firstSeen: string;
}

export interface Ledger {
	pins: Record<string, ModelPin>;
}

export interface LedgerDeps {
	/** Home directory holding .8gent; default resolveHome(). */
	home?: string;
	env?: Env;
	fetch?: FetchLike;
	now?: () => Date;
	timeoutMs?: number;
}

export type CheckStatus = "pinned" | "unchanged" | "changed" | "cloud" | "unreachable";
export interface CheckResult {
	status: CheckStatus;
	/** Plain lines for the screen; empty when nothing needs saying. */
	lines: string[];
}

type LocalKind = "ollama" | "lmstudio" | "llama-server";

/** Provider ids served by a local server on this machine or LAN. Everything else is cloud. */
function localKind(provider: string): LocalKind | null {
	const p = provider.trim().toLowerCase().replace(/_/g, "-");
	if (p === "ollama" || p === "8gent") return "ollama";
	if (p === "lmstudio" || p === "lm-studio") return "lmstudio";
	if (p === "llama-server") return "llama-server";
	return null;
}

const keyOf = (provider: string, model: string) => `${provider}\n${model}`;

export function ledgerPath(home: string = resolveHome()): string {
	return path.join(home, ".8gent", "model-ledger.json");
}

export function readLedger(home: string = resolveHome()): Ledger {
	try {
		const raw = JSON.parse(fs.readFileSync(ledgerPath(home), "utf8"));
		if (raw && typeof raw === "object" && raw.pins && typeof raw.pins === "object") {
			return { pins: raw.pins as Record<string, ModelPin> };
		}
	} catch {}
	return { pins: {} };
}

function writeLedger(home: string, ledger: Ledger): void {
	const file = ledgerPath(home);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

type Live = { digest?: string; quant?: string; size?: string };

async function getJson(fetchImpl: FetchLike, url: string, timeoutMs: number, init?: RequestInit) {
	const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return (await res.json()) as any;
}

/** Ollama: digest from /api/tags, quantisation and size from /api/show. */
async function liveOllama(model: string, f: FetchLike, env: Env, t: number): Promise<Live | null> {
	const root = resolveOllamaBaseUrl(env);
	const tags = await getJson(f, `${root}/api/tags`, t);
	const names = [model, model.includes(":") ? model : `${model}:latest`];
	const hit = (tags.models ?? []).find((m: any) => names.includes(m?.name ?? m?.model));
	let details: any = {};
	try {
		const show = await getJson(f, `${root}/api/show`, t, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model }),
		});
		details = show?.details ?? {};
	} catch {}
	const live: Live = {
		digest: typeof hit?.digest === "string" ? hit.digest : undefined,
		quant: details.quantization_level || hit?.details?.quantization_level || undefined,
		size: details.parameter_size || hit?.details?.parameter_size || undefined,
	};
	return live.digest || live.quant ? live : null;
}

/** LM Studio: quantisation from its model info. It exposes no content digest. */
async function liveLmStudio(
	model: string,
	f: FetchLike,
	env: Env,
	t: number,
): Promise<Live | null> {
	const root = (env.LM_STUDIO_HOST || "http://localhost:1234").replace(/\/+$/, "");
	const body = await getJson(f, `${root}/api/v0/models`, t);
	const hit = (body.data ?? []).find((m: any) => m?.id === model);
	return hit?.quantization ? { quant: String(hit.quantization) } : null;
}

const QUANT_IN_PATH = /(IQ\d[A-Z0-9_]*|Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32)/i;

/** llama-server: quantisation read from the loaded file name in /props. No digest is exposed. */
async function liveLlama(model: string, f: FetchLike, env: Env, t: number): Promise<Live | null> {
	const root = resolveLlamaServerUrl(env);
	const props = await getJson(f, `${root}/props`, t);
	const file = path.basename(String(props?.model_path ?? model));
	const m = QUANT_IN_PATH.exec(file);
	return m ? { quant: m[1].toUpperCase() } : null;
}

async function readLive(
	provider: string,
	kind: LocalKind,
	model: string,
	d: LedgerDeps,
): Promise<Live | null> {
	const f = d.fetch ?? globalThis.fetch;
	const env = d.env ?? process.env;
	const t = d.timeoutMs ?? 3000;
	try {
		if (kind === "ollama") return await liveOllama(model, f, env, t);
		if (kind === "lmstudio") return await liveLmStudio(model, f, env, t);
		return await liveLlama(model, f, env, t);
	} catch {
		return null;
	}
}

const short = (digest?: string) =>
	digest ? digest.replace(/^sha256:/, "").slice(0, 12) : "unknown";
const dayOf = (iso: string) => {
	const d = new Date(iso);
	return Number.isNaN(d.getTime())
		? "the pin"
		: `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}`;
};

function describe(model: string, live: Live): string {
	const bits = [
		live.size,
		live.quant,
		live.digest ? `digest ${short(live.digest)}` : "no digest from this server",
	];
	return `${model}: ${bits.filter(Boolean).join(", ")}`;
}

/**
 * Compare the model in use with its pin, pinning on first sight. Local models
 * that changed keep their old pin until the user runs `8gent model-pin`.
 */
export async function checkModel(
	provider: string,
	model: string,
	deps: LedgerDeps = {},
): Promise<CheckResult> {
	const home = deps.home ?? resolveHome();
	const now = (deps.now ?? (() => new Date()))().toISOString();
	const ledger = readLedger(home);
	const key = keyOf(provider, model);
	const pin = ledger.pins[key];
	const kind = localKind(provider);

	if (!kind) {
		if (!pin) {
			ledger.pins[key] = { provider, model, cloud: true, firstSeen: now };
			try {
				writeLedger(home, ledger);
			} catch {}
		}
		return { status: "cloud", lines: [] };
	}

	const live = await readLive(provider, kind, model, deps);
	if (!live) {
		return {
			status: "unreachable",
			lines: [
				`Model ledger: the identity of ${model} on ${provider} could not be read, so it was not checked.`,
			],
		};
	}

	if (!pin) {
		ledger.pins[key] = { provider, model, ...live, firstSeen: now };
		try {
			writeLedger(home, ledger);
		} catch {}
		return { status: "pinned", lines: [`Model ledger: pinned ${describe(model, live)}.`] };
	}

	const changes: string[] = [];
	if (pin.digest && live.digest && pin.digest !== live.digest) {
		changes.push(`digest changed ${short(pin.digest)} to ${short(live.digest)}`);
	}
	if (pin.quant && live.quant && pin.quant !== live.quant) {
		changes.push(`quantisation changed: ${pin.quant} to ${live.quant}`);
	}
	if (changes.length === 0) return { status: "unchanged", lines: [] };
	return {
		status: "changed",
		lines: [
			`Model ledger: ${model} on ${provider} is not the model you pinned on ${dayOf(pin.firstSeen)}. ${changes.join("; ")}.`,
			`If you meant this, accept it with: 8gent model-pin ${model}`,
		],
	};
}

/** Accept the live identity of a model as its new pin. */
export async function repinModel(
	provider: string,
	model: string,
	deps: LedgerDeps = {},
): Promise<CheckResult> {
	const home = deps.home ?? resolveHome();
	const kind = localKind(provider);
	if (!kind)
		return {
			status: "cloud",
			lines: [`${model} on ${provider} is a cloud model: nothing to pin.`],
		};
	const live = await readLive(provider, kind, model, deps);
	if (!live) {
		return {
			status: "unreachable",
			lines: [`Could not read ${model} from ${provider}, so the pin was left as it was.`],
		};
	}
	const ledger = readLedger(home);
	const now = (deps.now ?? (() => new Date()))().toISOString();
	ledger.pins[keyOf(provider, model)] = { provider, model, ...live, firstSeen: now };
	writeLedger(home, ledger);
	return { status: "pinned", lines: [`Model ledger: pinned ${describe(model, live)}.`] };
}

/** Lines for `8gent doctor`: every pinned model. Empty when nothing is pinned yet. */
export function modelLedgerDoctorLines(home: string = resolveHome()): string[] {
	const pins = Object.values(readLedger(home).pins);
	if (pins.length === 0) return [];
	return [
		"Pinned models",
		...pins.map((p) =>
			p.cloud
				? `  ${p.model} (${p.provider}, cloud, no digest)`
				: `  ${[p.model, `(${p.provider})`, p.size, p.quant, `digest ${short(p.digest)}`].filter(Boolean).join(" ")}`,
		),
	];
}
