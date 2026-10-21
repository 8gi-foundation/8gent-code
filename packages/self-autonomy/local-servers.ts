/**
 * First-run local model server detection, the choice screen, and saving the
 * choice (#4206).
 *
 * Detection is by HTTP on loopback, never by process name, so the same probe
 * finds llama-server.exe on Windows, LM Studio on Linux and Ollama on macOS.
 * Every probe is bounded and they run at once, so a first run never waits
 * more than LOCAL_PROBE_TIMEOUT_MS on a machine with nothing listening.
 *
 * Ollama is not probed here: the launch-time probeOllama result is passed in,
 * so first run asks it once.
 */

import {
	isLlamaServerSelected,
	isLoopbackUrl,
	resolveLlamaServerUrl,
} from "../local-model-server/select";
import { type ProviderManager, getProviderManager } from "../providers/index";
import { KEYS_FILE_DISPLAY } from "./model-recipes";

type Env = Record<string, string | undefined>;

export type LocalServerId = "ollama" | "lmstudio" | "llama-server" | "apfel";

export interface FoundServer {
	id: LocalServerId;
	label: string;
	/** Root URL that answered, e.g. http://127.0.0.1:8080. */
	url: string;
	/** Chat models it listed, embedding models left out. May be empty. */
	models: string[];
}

/** Each new probe gets this long. A local server answers in milliseconds. */
export const LOCAL_PROBE_TIMEOUT_MS = 1500;

export const DEFAULT_LM_STUDIO_URL = "http://127.0.0.1:1234";
export const DEFAULT_APFEL_URL = "http://127.0.0.1:11435";

export const SERVER_LABELS: Record<LocalServerId, string> = {
	ollama: "Ollama",
	lmstudio: "LM Studio",
	"llama-server": "llama-server (llama.cpp)",
	apfel: "apfel (Apple Foundation Model)",
};

/** Install guides per OS, written alongside this change (docs, #4206). */
const DOCS = "https://github.com/8gi-foundation/8gent-code/blob/main/docs";
export function installGuideUrl(platform: string): string {
	const page = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux";
	return `${DOCS}/install/${page}.md`;
}
export const PROVIDERS_GUIDE_URL = `${DOCS}/install/providers.md`;

function withScheme(url: string): string {
	const v = url.trim().replace(/\/+$/, "");
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`;
}

const isEmbedding = (id: string) => /embed|nomic|bge-/i.test(id);

async function getJson(
	fetchImpl: typeof fetch,
	url: string,
	timeoutMs: number,
): Promise<unknown | null> {
	try {
		// redirect "manual": a loopback port cannot send the probe elsewhere.
		// A 3xx (or the opaque redirect a browser-style fetch returns) is a miss.
		const res = await fetchImpl(url, {
			signal: AbortSignal.timeout(timeoutMs),
			redirect: "manual",
		});
		if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400) || !res.ok)
			return null;
		return await res.json().catch(() => ({}));
	} catch {
		return null;
	}
}

function openAiIds(body: unknown): string[] | null {
	const data = (body as { data?: unknown } | null)?.data;
	if (!Array.isArray(data)) return null;
	return data.flatMap((m) => {
		const id = m && typeof m === "object" ? (m as { id?: unknown }).id : undefined;
		return typeof id === "string" && id && !isEmbedding(id) ? [id] : [];
	});
}

/** An OpenAI-shaped server: found when /v1/models answers with a `data` list. */
async function probeOpenAiServer(
	id: LocalServerId,
	root: string,
	fetchImpl: typeof fetch,
	timeoutMs: number,
): Promise<FoundServer | null> {
	if (!isLoopbackUrl(root)) return null;
	const ids = openAiIds(await getJson(fetchImpl, `${root}/v1/models`, timeoutMs));
	return ids ? { id, label: SERVER_LABELS[id], url: root, models: ids } : null;
}

/**
 * llama-server: found when GET /health answers 200 (model loaded) and
 * /v1/models answers with a `data` list. Both, so an unrelated web app on
 * 8080 with a /health route is not mistaken for it.
 */
async function probeLlamaServer(
	root: string,
	fetchImpl: typeof fetch,
	timeoutMs: number,
): Promise<FoundServer | null> {
	if (!isLoopbackUrl(root)) return null;
	const [health, models] = await Promise.all([
		getJson(fetchImpl, `${root}/health`, timeoutMs),
		getJson(fetchImpl, `${root}/v1/models`, timeoutMs),
	]);
	const ids = openAiIds(models);
	if (health === null || ids === null) return null;
	return { id: "llama-server", label: SERVER_LABELS["llama-server"], url: root, models: ids };
}

export interface DetectOptions {
	env?: Env;
	platform?: string;
	arch?: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	/** The launch-time Ollama probe result, reused rather than asked again. */
	ollama?: { status: string; host?: string; models?: string[] } | null;
}

/**
 * Every local model server answering on this machine, in the order the
 * startup picker already prefers (a selected llama-server, then LM Studio,
 * then Ollama, then apfel), so the first choice matches today's default.
 */
export async function detectLocalServers(opts: DetectOptions = {}): Promise<FoundServer[]> {
	const env = opts.env ?? process.env;
	const platform = opts.platform ?? process.platform;
	const arch = opts.arch ?? process.arch;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const timeoutMs = opts.timeoutMs ?? LOCAL_PROBE_TIMEOUT_MS;

	const lmRoot = withScheme(env.LM_STUDIO_HOST || DEFAULT_LM_STUDIO_URL);
	const apfelRoot = withScheme((env.APFEL_BASE_URL || DEFAULT_APFEL_URL).replace(/\/v1\/?$/, ""));
	const appleSilicon = platform === "darwin" && arch === "arm64";

	const [llama, lm, apfel] = await Promise.all([
		probeLlamaServer(resolveLlamaServerUrl(env), fetchImpl, timeoutMs),
		probeOpenAiServer("lmstudio", lmRoot, fetchImpl, timeoutMs),
		appleSilicon
			? probeOpenAiServer("apfel", apfelRoot, fetchImpl, timeoutMs)
			: Promise.resolve(null),
	]);

	const o = opts.ollama;
	const ollama: FoundServer | null =
		o && o.status === "found"
			? {
					id: "ollama",
					label: SERVER_LABELS.ollama,
					url: o.host ?? "",
					models: (o.models ?? []).filter((m) => !isEmbedding(m)),
				}
			: null;

	const selected = isLlamaServerSelected(env);
	const ordered = selected ? [llama, lm, ollama, apfel] : [lm, ollama, llama, apfel];
	// A server with no chat model cannot answer yet, so it is not a choice:
	// picking it would save a model name that does not exist.
	return ordered.filter((s): s is FoundServer => s !== null && s.models.length > 0);
}

/** The model a choice saves: the 8gent model when Ollama serves it, else the first listed. */
export function preferredModel(server: FoundServer): string {
	const eight = server.models.find((m) => /^eight-/i.test(m));
	return eight ?? server.models[0] ?? "default";
}

/** A model id that is only a content hash, as Ollama lists a GGUF imported without a name. */
const HASH_ID = /^(?:([\w.-]+):)?([0-9a-f]{32,})$/i;

/**
 * A model id as a person reads it (#4221). Named ids keep their tag and lose
 * the registry and org path; a bare content hash
 * ("llamacpp:c97eb11d70b1...", 64 hex characters) becomes
 * "unnamed model c97eb11d". Display only: what gets saved is unchanged.
 */
export function readableModelName(id: string, max = 32): string {
	const hash = HASH_ID.exec(id);
	if (hash) return `unnamed model ${hash[2].slice(0, 8)}`;
	const last = id.split("/").pop() || id;
	return last.length > max ? `${last.slice(0, max - 1)}…` : last;
}

/**
 * The model line on a server's choice row: the model the choice saves, then
 * how many more. When that model is only a hash, a named model on the same
 * server is shown too, so the person recognises the server.
 */
export function serverModelsLine(server: FoundServer): string {
	const saved = preferredModel(server);
	const n = server.models.length;
	const more = n > 1 ? ` and ${n - 1} more` : "";
	const named = HASH_ID.test(saved) ? server.models.find((m) => !HASH_ID.test(m)) : undefined;
	return `${readableModelName(saved)}${more}${named ? `, including ${readableModelName(named)}` : ""}`;
}

/** The one step that gives OpenRouter a key: the keys file, then a fresh launch. */
const OPENROUTER_KEY_STEP =
	"run `8gent keys set openrouter` and paste your key from openrouter.ai (or `8gent keys` to edit the file), then run 8gent again";

/**
 * Plain next step when nothing is running: one install link for this OS.
 * Without an OpenRouter key the cloud line says the key comes first (#4218).
 */
export function noServerGuidance(platform: string, openRouterKey = true): string {
	return [
		"No local model server is running on this machine.",
		"",
		"Next step: install one (Ollama, LM Studio or llama-server), start it, then run 8gent again.",
		`Install guide for this computer: ${installGuideUrl(platform)}`,
		`Every provider, local and cloud: ${PROVIDERS_GUIDE_URL}`,
		"",
		openRouterKey
			? "Until then I can use free cloud models through OpenRouter."
			: `Free cloud models through OpenRouter need a free openrouter.ai account and its key: ${OPENROUTER_KEY_STEP}.`,
	].join("\n");
}

/**
 * What the chat says when the active provider needs a key and has none
 * (#4218). Null when nothing is missing. Waiting never fixes a missing key,
 * so this names the cause and the one step that does.
 */
export function missingKeyNotice(provider: string, hasKey: boolean): string | null {
	if (provider !== "openrouter" || hasKey) return null;
	return [
		"OpenRouter has no key, so nothing can run on it yet. Its free models need a free openrouter.ai account.",
		`Next step: ${OPENROUTER_KEY_STEP}. Or pick a local model server with /provider.`,
	].join("\n");
}

export interface ProviderChoiceScreen {
	question: string;
	choices: Array<{ label: string; value: string; description?: string }>;
}

const OPENROUTER_CHOICE = {
	label: "Free cloud models (OpenRouter)",
	value: "openrouter",
	// Short enough for one row beside the label at 120 columns (#4220).
	description: `Needs a free openrouter.ai key in ${KEYS_FILE_DISPLAY}`,
};
const MINIMAX_CHOICE = {
	label: "MiniMax",
	value: "minimax",
	description: `Needs a MiniMax key in ${KEYS_FILE_DISPLAY}`,
};
const LATER_CHOICE = {
	label: "Decide later",
	value: "later",
	description: "Save nothing now; /provider picks one any time",
};

/**
 * The choice screen for what detection found: none, one, or several.
 * `openRouterKey` defaults to whether OPENROUTER_API_KEY is set (keys.env is
 * loaded into the env at launch). With no server and no key, Enter is
 * "Decide later": it used to save OpenRouter with no key, a dead end (#4218).
 */
export function providerChoiceScreen(
	found: FoundServer[],
	platform: string,
	opts: { openRouterKey?: boolean } = {},
): ProviderChoiceScreen {
	const openRouterKey = opts.openRouterKey ?? Boolean(process.env.OPENROUTER_API_KEY);
	const local = found.map((s) => {
		const where = s.url.replace(/^https?:\/\//, "");
		return { label: s.label, value: s.id, description: `${serverModelsLine(s)}, at ${where}` };
	});
	if (found.length === 0) {
		return {
			question: noServerGuidance(platform, openRouterKey),
			choices: openRouterKey
				? [OPENROUTER_CHOICE, MINIMAX_CHOICE, LATER_CHOICE]
				: [LATER_CHOICE, OPENROUTER_CHOICE, MINIMAX_CHOICE],
		};
	}
	const question =
		found.length === 1
			? `I found ${found[0].label} running on this machine. Shall I use it?`
			: `I found ${found.length} local model servers on this machine. Which should I use?`;
	return { question, choices: [...local, OPENROUTER_CHOICE, MINIMAX_CHOICE, LATER_CHOICE] };
}

export interface ProviderChoice {
	provider: LocalServerId | HostedKeyProvider;
	/** "" for a hosted provider whose model comes from its live list after the key is saved. */
	model: string;
}

export type HostedKeyProvider = "openrouter" | "minimax";

/** The hosted providers the first-run screen offers by name, and the key each one reads. */
export const HOSTED_KEY_PROVIDERS: Record<
	HostedKeyProvider,
	{ label: string; env: string; keyUrl: string }
> = {
	openrouter: {
		label: "OpenRouter",
		env: "OPENROUTER_API_KEY",
		keyUrl: "https://openrouter.ai/keys",
	},
	minimax: { label: "MiniMax", env: "MINIMAX_API_KEY", keyUrl: "https://www.minimax.io" },
};

/** The hosted provider a choice needs a key for, or null when it has one (or needs none). */
export function hostedKeyNeeded(
	provider: string,
	env: Env = process.env,
): (typeof HOSTED_KEY_PROVIDERS)[HostedKeyProvider] | null {
	const h = HOSTED_KEY_PROVIDERS[provider as HostedKeyProvider];
	if (!h) return null;
	return (env[h.env] ?? "").trim() ? null : h;
}

/** Map an answer on the choice screen to what gets saved. Null for "later" or unknown. */
export function resolveProviderChoice(answer: string, found: FoundServer[]): ProviderChoice | null {
	const value = answer.trim().toLowerCase();
	if (value === "openrouter") return { provider: "openrouter", model: "auto:free" };
	if (value === "minimax") return { provider: "minimax", model: "" };
	const server = found.find((s) => s.id === value);
	return server ? { provider: server.id, model: preferredModel(server) } : null;
}

/**
 * Save the choice where the TUI reads it at launch (providers.json
 * activeProvider / activeModel). llama-server is marked enabled, since the
 * registry only enables it by default under EIGHT_LOCAL_SERVER. Nothing
 * else in the file changes: keys and other providers stay as they were.
 */
export function saveProviderChoice(
	choice: ProviderChoice,
	manager: ProviderManager = getProviderManager(),
): void {
	if (choice.provider === "llama-server") manager.enableProvider("llama-server");
	manager.setActiveProvider(choice.provider);
	if (choice.model) manager.setActiveModel(choice.model);
}
