/**
 * Project settings (matrix row N2).
 *
 * Pi deep-merges <cwd>/.pi/settings.json over its global file. Here the
 * project file is <cwd>/.8gent/settings.json, merged over ~/.8gent/settings.json.
 *
 * SECURITY. A project file is repository content: anyone who can commit to a
 * repo can put one in front of a user who runs 8gent there. So a project file
 * is not a second settings file with the same powers. It may set ONLY the leaf
 * keys in PROJECT_SETTINGS_ALLOWLIST (look and feel, which model a tab uses
 * among local providers (or the one the tab already uses), and retry limits), each
 * checked by a validator. Everything else is dropped and reported, whatever
 * its name: permissions, shell paths, provider base URLs or keys, tools,
 * hooks, anything that runs code or sends data somewhere new. A new settings
 * key is therefore forbidden in a project file until someone adds it here.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { RETRY_LIMITS } from "./retry.js";
import type { Settings } from "./schema.js";

export interface IgnoredSetting {
	/** Dotted path of the key as written in the project file. */
	path: string;
	reason: string;
}

type Validator = (value: unknown, global: Settings) => boolean;

const isInt = (min: number, max: number): Validator => (v) =>
	typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const isNum = (min: number, max: number): Validator => (v) =>
	typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const isBool: Validator = (v) => typeof v === "boolean";
const oneOf =
	(...allowed: string[]): Validator =>
	(v) =>
		typeof v === "string" && allowed.includes(v);
/** Short plain text: no control characters, so it cannot smuggle terminal escapes. */
const shortText =
	(max: number): Validator =>
	(v) =>
		typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
/** True when a base URL points at this machine: http(s) to 127.0.0.1, ::1 or localhost. */
export function isLoopbackBaseURL(raw: unknown): boolean {
	if (typeof raw !== "string") return false;
	try {
		const u = new URL(raw.trim());
		if (u.protocol !== "http:" && u.protocol !== "https:") return false;
		const host = u.hostname.toLowerCase();
		return host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "localhost";
	} catch {
		return false;
	}
}

const baseURLOf = (g: Settings, provider: string | undefined): string | undefined =>
	provider ? (g.providers as unknown as Record<string, { baseURL?: string } | undefined>)[provider]?.baseURL : undefined;

/**
 * A provider a project file may pick for a tab. A repo must not be able to send
 * the user's code to a hosted provider (openrouter is always present in the
 * global providers block, so "already configured" proves nothing). So it is
 * allowed only when that provider's effective GLOBAL base URL is loopback, or
 * when it is the provider that tab already uses globally (nothing new leaves
 * the machine). A provider the user pointed at a remote host is refused.
 */
const pickableProvider =
	(tab: (typeof TABS)[number]): Validator =>
	(v, g) => {
		if (typeof v !== "string" || !Object.prototype.hasOwnProperty.call(g.providers, v)) return false;
		if (g.models?.tabs?.[tab]?.provider === v) return true;
		return isLoopbackBaseURL(baseURLOf(g, v));
	};

/**
 * Model ids that route to a hosted provider whatever the provider key says:
 * "auto:free" is resolved to OpenRouter by resolveModel, and ":free" ids are
 * OpenRouter's free tier; names ending "-cloud" or ":cloud" are Ollama cloud
 * models, which run off-machine even through a loopback Ollama. A project may name one only when that tab's global
 * provider is already non-loopback (the user already sends that tab off-machine).
 */
export function impliesHostedProvider(model: string): boolean {
	const m = model.trim().toLowerCase();
	return m === "auto:free" || m.endsWith(":free") || m.endsWith("-cloud") || m.endsWith(":cloud");
}
const projectModel =
	(tab: (typeof TABS)[number]): Validator =>
	(v, g) => {
		if (!shortText(200)(v, g)) return false;
		if (!impliesHostedProvider(v as string)) return true;
		return !isLoopbackBaseURL(baseURLOf(g, g.models?.tabs?.[tab]?.provider));
	};

const TABS = ["orchestrator", "engineer", "qa"] as const;

/** dotted leaf path -> validator. The ONLY keys a project file may set. */
export const PROJECT_SETTINGS_ALLOWLIST: Readonly<Record<string, Validator>> = Object.freeze({
	// UI
	"ui.theme": shortText(64),
	"ui.thinkingVisualiser.enabled": isBool,
	"ui.thinkingVisualiser.operatorRotationMs": isNum(100, 600_000),
	"ui.thinkingVisualiser.boredomThresholdMs": isNum(100, 600_000),
	"performance.introBanner": oneOf("auto", "on", "off"),
	// Model choice: local providers or the tab's current provider only (never a new hosted one)
	...Object.fromEntries(
		TABS.flatMap((t) => [
			[`models.tabs.${t}.provider`, pickableProvider(t)],
			[`models.tabs.${t}.model`, projectModel(t)],
		]),
	),
	// Retry limits (bounded, so a repo cannot turn retries into a flood or a stall)
	"retry.maxRetries": isInt(RETRY_LIMITS.maxRetries.min, RETRY_LIMITS.maxRetries.max),
	"retry.maxDelayMs": isInt(RETRY_LIMITS.maxDelayMs.min, RETRY_LIMITS.maxDelayMs.max),
	"retry.httpIdleTimeoutMs": isInt(RETRY_LIMITS.httpIdleTimeoutMs.min, RETRY_LIMITS.httpIdleTimeoutMs.max),
});

const LEAVES = Object.keys(PROJECT_SETTINGS_ALLOWLIST);
const isPlain = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Split a parsed project file into what may apply and what is ignored.
 * `accepted` maps allowlisted dotted paths to their (validated) values.
 */
export function filterProjectSettings(
	parsed: unknown,
	global: Settings,
): { accepted: Record<string, unknown>; ignored: IgnoredSetting[] } {
	const accepted: Record<string, unknown> = {};
	const ignored: IgnoredSetting[] = [];
	if (!isPlain(parsed)) {
		if (parsed !== undefined) ignored.push({ path: "(file)", reason: "not a JSON object" });
		return { accepted, ignored };
	}
	const walk = (node: Record<string, unknown>, prefix: string): void => {
		for (const key of Object.keys(node)) {
			const p = prefix ? `${prefix}.${key}` : key;
			const value = node[key];
			if (prefix === "" && key === "version") continue; // harmless marker, never applied
			const validator = Object.prototype.hasOwnProperty.call(PROJECT_SETTINGS_ALLOWLIST, p)
				? PROJECT_SETTINGS_ALLOWLIST[p]
				: undefined;
			if (validator) {
				if (validator(value, global)) accepted[p] = value;
				else ignored.push({ path: p, reason: "value is not valid here" });
			} else if (isPlain(value) && LEAVES.some((l) => l.startsWith(`${p}.`))) {
				walk(value, p);
			} else {
				ignored.push({ path: p, reason: "a project settings file may not set this" });
			}
		}
	};
	walk(parsed, "");
	return { accepted, ignored };
}

/** Largest project file read. A settings file is a few hundred bytes. */
const MAX_PROJECT_FILE_BYTES = 64 * 1024;

export function projectSettingsPath(cwd: string): string {
	return path.join(cwd, ".8gent", "settings.json");
}

/**
 * Read <cwd>/.8gent/settings.json. Returns undefined when there is none, when
 * it is the global file itself (cwd = home), a symlink, not a regular file, too
 * large or not JSON. A broken project file never breaks startup.
 */
export function readProjectSettingsFile(
	cwd: string,
	globalFile: string,
): { file: string; parsed: unknown } | { file: string; error: string } | undefined {
	const file = projectSettingsPath(cwd);
	try {
		const st = fs.lstatSync(file);
		if (!st.isFile()) return st.isSymbolicLink() ? { file, error: "is a symlink, not read" } : undefined;
		let same = false;
		try {
			same = fs.realpathSync(file) === fs.realpathSync(globalFile);
		} catch {}
		if (same) return undefined;
		if (st.size > MAX_PROJECT_FILE_BYTES) return { file, error: "is larger than 64 KB, not read" };
		return { file, parsed: JSON.parse(fs.readFileSync(file, "utf-8")) as unknown };
	} catch (e) {
		if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
		return { file, error: "could not be read as JSON" };
	}
}

/** Set a dotted path on a clone-safe plain object tree (paths come from the allowlist only). */
export function setPath(target: Record<string, unknown>, dotted: string, value: unknown): void {
	const parts = dotted.split(".");
	let node = target;
	for (let i = 0; i < parts.length - 1; i++) {
		const next = node[parts[i]];
		node[parts[i]] = isPlain(next) ? { ...next } : {};
		node = node[parts[i]] as Record<string, unknown>;
	}
	node[parts[parts.length - 1]] = value;
}

export function getPath(source: unknown, dotted: string): unknown {
	let node: unknown = source;
	for (const part of dotted.split(".")) {
		if (!isPlain(node)) return undefined;
		node = node[part];
	}
	return node;
}
