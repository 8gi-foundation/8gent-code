/**
 * Per-officer CHAT configuration - the officer's brain, as opposed to
 * harness-config.ts which owns their hands (the execution CLI).
 *
 * Everything an officer is can be overridden here without touching code:
 * which inference backend answers as them, which model, what persona they hold,
 * and how hot they run. Stored at ~/.8gent/table-officers.json alongside the
 * other local, non-repo config, and re-read on EVERY resolve so an edit - from
 * the file or from a chat command - takes effect on the next message with no
 * restart.
 *
 * The friendly part lives in `resolveModelTarget`: name a model and the right
 * provider + baseUrl are worked out by asking the machine which server actually
 * has it. You should never have to remember that ornith lives on port 1234.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverLocalInference, discoverCloudProviders } from "./discovery";
import { OFFICERS } from "./officers";

export interface OfficerChatOverride {
	/** Inference backend id: a local provider ("lmstudio") or a cloud one ("openai"). */
	provider?: string;
	model?: string;
	baseUrl?: string;
	/** The officer's persona - the first line of their system prompt. */
	systemPrompt?: string;
	temperature?: number;
	/** Display name, so an officer can be renamed to suit the team. */
	name?: string;
	role?: string;
}

export type OfficerConfigFile = Record<string, OfficerChatOverride>;

function configPath(): string {
	const override = process.env.TABLE_OFFICER_CONFIG;
	if (override?.trim()) return override.trim();
	return path.join(os.homedir(), ".8gent", "table-officers.json");
}

/** Read fresh every time; a malformed file must never break a reply. */
export function readOfficerConfig(): OfficerConfigFile {
	try {
		const raw = fs.readFileSync(configPath(), "utf8");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? (parsed as OfficerConfigFile) : {};
	} catch {
		return {};
	}
}

function writeOfficerConfig(cfg: OfficerConfigFile): void {
	const p = configPath();
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`);
}

/** The officer as it will actually run: coded roster + any human override. */
export function resolveOfficer(code: string): {
	code: string; name: string; role: string;
	provider: string; model: string; baseUrl?: string;
	systemPrompt: string; temperature?: number;
	overridden: string[];
} | undefined {
	const upper = code.toUpperCase();
	const base = (OFFICERS as Record<string, any>)[upper];
	if (!base) return undefined;
	const o = readOfficerConfig()[upper] ?? {};
	const overridden = Object.keys(o).filter((k) => (o as any)[k] !== undefined);
	return {
		code: upper,
		name: o.name ?? base.name,
		role: o.role ?? base.role,
		provider: o.provider ?? base.provider,
		model: o.model ?? base.model,
		baseUrl: o.baseUrl ?? base.baseUrl,
		systemPrompt: o.systemPrompt ?? base.systemPrompt,
		temperature: o.temperature,
		overridden,
	};
}

/** Apply one field. Returns a human-readable confirmation or an error string. */
export async function setOfficerField(
	code: string, field: string, value: string,
): Promise<{ ok: boolean; message: string }> {
	const upper = code.toUpperCase();
	if (!(OFFICERS as Record<string, any>)[upper]) {
		return { ok: false, message: `Unknown officer "${code}".` };
	}
	const cfg = readOfficerConfig();
	const entry: OfficerChatOverride = { ...(cfg[upper] ?? {}) };

	switch (field.toLowerCase()) {
		case "model": {
			const target = await resolveModelTarget(value);
			if (!target.ok) return { ok: false, message: target.message };
			entry.model = target.model;
			entry.provider = target.provider;
			entry.baseUrl = target.baseUrl;
			cfg[upper] = entry;
			writeOfficerConfig(cfg);
			return { ok: true, message: `${upper} now answers on **${target.model}** via ${target.provider}${target.baseUrl ? ` (${target.baseUrl})` : ""}.` };
		}
		case "persona":
		case "prompt": {
			if (!value.trim()) return { ok: false, message: "Give me the persona text." };
			entry.systemPrompt = value.trim();
			cfg[upper] = entry; writeOfficerConfig(cfg);
			return { ok: true, message: `${upper}'s persona updated.` };
		}
		case "name": {
			if (!value.trim()) return { ok: false, message: "Give me a name." };
			entry.name = value.trim();
			cfg[upper] = entry; writeOfficerConfig(cfg);
			return { ok: true, message: `${upper} is now called **${value.trim()}**.` };
		}
		case "role": {
			entry.role = value.trim();
			cfg[upper] = entry; writeOfficerConfig(cfg);
			return { ok: true, message: `${upper}'s role is now "${value.trim()}".` };
		}
		case "temperature": {
			const t = Number(value);
			if (!Number.isFinite(t) || t < 0 || t > 2) return { ok: false, message: "Temperature must be between 0 and 2." };
			entry.temperature = t;
			cfg[upper] = entry; writeOfficerConfig(cfg);
			return { ok: true, message: `${upper} now runs at temperature ${t}.` };
		}
		case "reset": {
			delete cfg[upper];
			writeOfficerConfig(cfg);
			return { ok: true, message: `${upper} reset to their built-in defaults.` };
		}
		default:
			return { ok: false, message: `I can set: model, persona, name, role, temperature, reset.` };
	}
}

/**
 * Work out where a named model actually lives. Checks every reachable local
 * server first (sovereign by default), then falls back to a cloud provider that
 * has a credential. Exact match wins; otherwise a unique case-insensitive
 * substring match is accepted so "gemma" finds the long real name.
 */
export async function resolveModelTarget(
	wanted: string,
): Promise<{ ok: true; provider: string; model: string; baseUrl?: string } | { ok: false; message: string }> {
	const want = wanted.trim();
	if (!want) return { ok: false, message: "Which model?" };

	const local = await discoverLocalInference();
	const hits: Array<{ provider: string; model: string; baseUrl: string }> = [];
	for (const ep of local) {
		if (!ep.reachable) continue;
		for (const m of ep.models) {
			if (m === want) return { ok: true, provider: ep.provider, model: m, baseUrl: ep.baseUrl };
			if (m.toLowerCase().includes(want.toLowerCase())) {
				hits.push({ provider: ep.provider, model: m, baseUrl: ep.baseUrl });
			}
		}
	}
	if (hits.length === 1) return { ok: true, ...hits[0] };
	if (hits.length > 1) {
		return { ok: false, message: `"${want}" matches several models: ${hits.map((h) => h.model).join(", ")}. Name one exactly.` };
	}

	// Not local - is it a cloud provider the user has a key for?
	const cloud = discoverCloudProviders().filter((c) => c.configured);
	const byName = cloud.find((c) => want.toLowerCase().startsWith(`${c.provider}/`));
	if (byName) {
		return { ok: true, provider: byName.provider, model: want.slice(byName.provider.length + 1) };
	}
	const ready = cloud.map((c) => c.provider).join(", ") || "none";
	return {
		ok: false,
		message: `No local server has a model matching "${want}". For a cloud model use provider/model (configured: ${ready}).`,
	};
}
