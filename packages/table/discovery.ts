/**
 * Discovery - what can an officer actually be connected to, right now, on this
 * machine? Probed live, never hardcoded, so the answer is the truth rather than
 * a stale list someone forgot to update.
 *
 * Three independent things an officer can be pointed at:
 *  1. LOCAL INFERENCE - an OpenAI-compatible (or Ollama) server on this box. We
 *     probe the well-known ports and ASK each one for its model list.
 *  2. CLOUD APIS - detected purely by the presence of a credential. We never read
 *     the secret's value, never log it, never send it anywhere; we only report
 *     that a key exists so the UI can offer the provider.
 *  3. HARNESSES - third-party agent CLIs installed on PATH (claude, codex, pi...).
 *     Verified by resolving the binary, not by assuming.
 *
 * Everything here is READ-ONLY and safe to run on demand from a chat command.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── local inference ──────────────────────────────────────────────────────────

export interface LocalEndpoint {
	/** Stable id used in officer config, e.g. "lmstudio". */
	provider: string;
	label: string;
	baseUrl: string;
	/** OpenAI-style /v1/models, or Ollama's /api/tags. */
	dialect: "openai" | "ollama";
	reachable: boolean;
	models: string[];
	note?: string;
}

/** Well-known local servers. Ports are the projects' own defaults. */
const LOCAL_CANDIDATES: Array<Omit<LocalEndpoint, "reachable" | "models">> = [
	{ provider: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434", dialect: "ollama" },
	{ provider: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234", dialect: "openai" },
	{ provider: "apfel", label: "Apple Foundation (apfel)", baseUrl: "http://127.0.0.1:11435", dialect: "openai" },
	{ provider: "llamacpp", label: "llama.cpp server", baseUrl: "http://127.0.0.1:8080", dialect: "openai" },
	{ provider: "vllm", label: "vLLM", baseUrl: "http://127.0.0.1:8000", dialect: "openai" },
	{ provider: "jan", label: "Jan", baseUrl: "http://127.0.0.1:1337", dialect: "openai" },
	{ provider: "localai", label: "LocalAI", baseUrl: "http://127.0.0.1:8081", dialect: "openai" },
	{ provider: "mlx", label: "MLX server", baseUrl: "http://127.0.0.1:8082", dialect: "openai" },
];

async function probe(c: (typeof LOCAL_CANDIDATES)[number], timeoutMs: number): Promise<LocalEndpoint> {
	const url = c.dialect === "ollama" ? `${c.baseUrl}/api/tags` : `${c.baseUrl}/v1/models`;
	try {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), timeoutMs);
		const res = await fetch(url, { signal: ctrl.signal });
		clearTimeout(t);
		if (!res.ok) return { ...c, reachable: false, models: [], note: `HTTP ${res.status}` };
		const json: any = await res.json();
		const models: string[] =
			c.dialect === "ollama"
				? (json?.models ?? []).map((m: any) => String(m?.name ?? "")).filter(Boolean)
				: (json?.data ?? []).map((m: any) => String(m?.id ?? "")).filter(Boolean);
		return { ...c, reachable: true, models };
	} catch {
		return { ...c, reachable: false, models: [] };
	}
}

/** Probe every known local server in parallel. Unreachable ones are reported, not hidden. */
export async function discoverLocalInference(timeoutMs = 1500): Promise<LocalEndpoint[]> {
	return Promise.all(LOCAL_CANDIDATES.map((c) => probe(c, timeoutMs)));
}

// ── cloud providers ──────────────────────────────────────────────────────────

export interface CloudProvider {
	provider: string;
	label: string;
	/** The env var that would hold the credential. */
	envVar: string;
	/** True when a credential is present. THE VALUE IS NEVER READ OUT. */
	configured: boolean;
	source?: "env" | "dotenv";
}

const CLOUD_CANDIDATES: Array<{ provider: string; label: string; envVar: string }> = [
	{ provider: "anthropic", label: "Anthropic", envVar: "ANTHROPIC_API_KEY" },
	{ provider: "openai", label: "OpenAI", envVar: "OPENAI_API_KEY" },
	{ provider: "openrouter", label: "OpenRouter", envVar: "OPENROUTER_API_KEY" },
	{ provider: "groq", label: "Groq", envVar: "GROQ_API_KEY" },
	{ provider: "mistral", label: "Mistral", envVar: "MISTRAL_API_KEY" },
	{ provider: "together", label: "Together", envVar: "TOGETHER_API_KEY" },
	{ provider: "fireworks", label: "Fireworks", envVar: "FIREWORKS_API_KEY" },
	{ provider: "deepseek", label: "DeepSeek", envVar: "DEEPSEEK_API_KEY" },
	{ provider: "minimax", label: "MiniMax", envVar: "MINIMAX_API_KEY" },
	{ provider: "xai", label: "xAI / Grok", envVar: "XAI_API_KEY" },
	{ provider: "gemini", label: "Google Gemini", envVar: "GEMINI_API_KEY" },
	{ provider: "replicate", label: "Replicate", envVar: "REPLICATE_API_TOKEN" },
];

/** Env files we consult for credential PRESENCE only. */
const DOTENV_PATHS = [
	path.join(os.homedir(), ".claude", ".env"),
	path.join(os.homedir(), "8gi-governance", ".env"),
	path.join(os.homedir(), ".8gent", ".env"),
];

/** Which env var names appear in the dotenv files. Values are never captured. */
function dotenvKeyNames(): Set<string> {
	const names = new Set<string>();
	for (const p of DOTENV_PATHS) {
		try {
			for (const line of fs.readFileSync(p, "utf8").split("\n")) {
				const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*\S/);
				if (m) names.add(m[1]);
			}
		} catch {
			/* absent file is simply "no keys here" */
		}
	}
	return names;
}

export function discoverCloudProviders(): CloudProvider[] {
	const inFiles = dotenvKeyNames();
	return CLOUD_CANDIDATES.map((c) => {
		const inEnv = Boolean(process.env[c.envVar]?.trim());
		const inFile = inFiles.has(c.envVar);
		return {
			...c,
			configured: inEnv || inFile,
			source: inEnv ? "env" : inFile ? "dotenv" : undefined,
		};
	});
}

// ── harnesses ────────────────────────────────────────────────────────────────

export interface HarnessInfo {
	kind: string;
	binary: string;
	installed: boolean;
	pathTo?: string;
	note?: string;
}

/** Agent CLIs an officer can execute through. `shell` is always available. */
const HARNESS_CANDIDATES: Array<{ kind: string; binary: string }> = [
	{ kind: "shell", binary: "bash" },
	{ kind: "claude", binary: "claude" },
	{ kind: "codex", binary: "codex" },
	{ kind: "8gent-local", binary: "8gent" },
	{ kind: "pi", binary: "pi" },
	{ kind: "opencode", binary: "opencode" },
	{ kind: "cursor-agent", binary: "cursor-agent" },
	{ kind: "goose", binary: "goose" },
	{ kind: "aider", binary: "aider" },
];

/**
 * The PATH a Helm worker really gets. The daemon's own PATH is narrower than the
 * relay's, so probing with it under-reports harnesses that workers CAN reach -
 * "installed in this process" is a different question from "reachable by a
 * worker", and the second is the one that matters. Node/npm bin dirs are globbed
 * because the active version changes.
 */
function workerPath(): string {
	const home = os.homedir();
	const extra = [
		path.join(home, ".local", "bin"),
		path.join(home, ".bun", "bin"),
		"/opt/homebrew/bin",
		"/opt/homebrew/sbin",
		"/usr/local/bin",
	];
	try {
		const nvm = path.join(home, ".nvm", "versions", "node");
		for (const v of fs.readdirSync(nvm)) extra.push(path.join(nvm, v, "bin"));
	} catch {
		/* no nvm on this machine */
	}
	const current = (process.env.PATH ?? "").split(":").filter(Boolean);
	return Array.from(new Set([...current, ...extra])).join(":");
}

/**
 * Resolve each harness binary against the worker PATH (or an explicit override).
 */
export function discoverHarnesses(searchPath?: string): HarnessInfo[] {
	const env = { ...process.env, PATH: searchPath?.trim() || workerPath() };
	return HARNESS_CANDIDATES.map((h) => {
		try {
			const p = execFileSync("command", ["-v", h.binary], {
				env, encoding: "utf8", shell: "/bin/bash", stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			return { ...h, installed: Boolean(p), pathTo: p || undefined };
		} catch {
			return { ...h, installed: false };
		}
	});
}

// ── one call for the UI / chat command ───────────────────────────────────────

export interface DiscoveryReport {
	local: LocalEndpoint[];
	cloud: CloudProvider[];
	harnesses: HarnessInfo[];
	scannedAt: string;
}

export async function discoverAll(searchPath?: string): Promise<DiscoveryReport> {
	const [local, cloud, harnesses] = await Promise.all([
		discoverLocalInference(),
		Promise.resolve(discoverCloudProviders()),
		Promise.resolve(discoverHarnesses(searchPath)),
	]);
	return { local, cloud, harnesses, scannedAt: new Date().toISOString() };
}

/** Human-readable summary for a chat reply. Never prints a credential. */
export function formatDiscovery(r: DiscoveryReport): string {
	const lines: string[] = [];
	lines.push("**Local inference** (probed just now)");
	for (const l of r.local) {
		if (l.reachable) {
			const shown = l.models.slice(0, 6).join(", ");
			const more = l.models.length > 6 ? ` +${l.models.length - 6} more` : "";
			lines.push(`  UP    ${l.label} - ${l.baseUrl}${l.models.length ? `\n          models: ${shown}${more}` : " (no models listed)"}`);
		}
	}
	const down = r.local.filter((l) => !l.reachable).map((l) => l.label);
	if (down.length) lines.push(`  down  ${down.join(", ")}`);

	lines.push("", "**Cloud providers** (credential present - value never read)");
	const on = r.cloud.filter((c) => c.configured);
	const off = r.cloud.filter((c) => !c.configured);
	lines.push(on.length ? `  ready ${on.map((c) => c.label).join(", ")}` : "  (none configured)");
	if (off.length) lines.push(`  needs a key: ${off.map((c) => c.label).join(", ")}`);

	lines.push("", "**Harnesses** (execution CLIs)");
	const hOn = r.harnesses.filter((h) => h.installed).map((h) => h.kind);
	const hOff = r.harnesses.filter((h) => !h.installed).map((h) => h.kind);
	lines.push(hOn.length ? `  installed ${hOn.join(", ")}` : "  (none)");
	if (hOff.length) lines.push(`  missing   ${hOff.join(", ")}`);
	return lines.join("\n");
}
