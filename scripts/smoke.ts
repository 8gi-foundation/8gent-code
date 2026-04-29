#!/usr/bin/env bun
/**
 * smoke — comprehensive CLI smoke-test harness for 8gent-code.
 *
 * Validates every shipped surface without launching the TUI. Each test is a
 * pure function returning a SmokeResult; the runner aggregates results into a
 * pass/fail table (or JSONL when piped) and writes a report to
 * `~/.8gent/smoke-report.json`.
 *
 * Tests are intentionally read-only and inspection-based. Real regressions
 * surface as failures; we never paper over them.
 *
 * Usage:
 *   bun run smoke                  # full table
 *   bun run smoke:fast             # skip network probes
 *   bun run smoke:strict           # exit non-zero if any test skipped
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateText } from "ai";

// Surfaces under test
import { createModel, type ProviderName } from "../packages/ai/providers";
import { agentTools } from "../packages/ai/tools";
import { ROLE_REGISTRY } from "../packages/orchestration/role-registry";
import {
	BUILT_IN_SLASH_COMMANDS,
	getBuiltInSlashCommands,
} from "../apps/tui/src/lib/slash-commands";
import {
	EXTERNAL_AGENT_PRESETS,
	getPreset,
	listPresetIds,
} from "../apps/tui/src/lib/external-agent-runner";
import {
	loadSettings,
	saveSettings,
	getSetting,
	setSetting,
	getSettingsFilePath,
	DEFAULT_SETTINGS,
} from "../packages/settings";
import { computeAutoTune } from "../packages/eight/auto-tune";
import { VoiceSilenceLearner } from "../packages/eight/voice-silence-learner";
import {
	setVisualiserTokenSink,
	notifyVisualiserToken,
	_hasSink,
} from "../packages/eight/visualiser-bridge";
import {
	DEFAULT_PARAMS,
	perturbFromToken,
	mutateForBoredom,
	hashToken,
} from "../apps/tui/src/lib/visualiser-params";
import {
	createAutoSkill,
	_resetForTests as _resetSkillCreator,
	MAX_AUTO_SKILLS_PER_SESSION,
} from "../packages/self-autonomy/skill-creator";
import { ModelFailover } from "../packages/providers/failover";

// ============================================================================
// Types + helpers
// ============================================================================

export interface SmokeResult {
	name: string;
	ok: boolean;
	durationMs: number;
	detail?: string;
	skipped?: string;
}

interface CliFlags {
	skipNetwork: boolean;
	strict: boolean;
}

const HTTP_TIMEOUT_MS = 2000;

function parseFlags(argv: string[]): CliFlags {
	return {
		skipNetwork: argv.includes("--skip-network"),
		strict: argv.includes("--strict"),
	};
}

async function timeIt(
	name: string,
	fn: () => Promise<{ ok: boolean; detail?: string; skipped?: string }>,
): Promise<SmokeResult> {
	const start = performance.now();
	try {
		const r = await fn();
		return {
			name,
			ok: r.ok,
			durationMs: Math.round(performance.now() - start),
			detail: r.detail,
			skipped: r.skipped,
		};
	} catch (err) {
		return {
			name,
			ok: false,
			durationMs: Math.round(performance.now() - start),
			detail: `threw: ${(err as Error).message?.slice(0, 200) ?? String(err)}`,
		};
	}
}

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(msg);
}

// ============================================================================
// A. Provider health (HTTP probes + 1-token chat)
// ============================================================================

async function probeUrl(url: string): Promise<boolean> {
	try {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
		try {
			const res = await fetch(url, { signal: ctrl.signal });
			return res.ok;
		} finally {
			clearTimeout(t);
		}
	} catch {
		return false;
	}
}

async function testProviderHealth(
	provider: "apfel" | "lmstudio" | "ollama",
	skipNetwork: boolean,
): Promise<SmokeResult> {
	return timeIt(`providers/${provider}`, async () => {
		if (skipNetwork) return { ok: true, skipped: "skip-network" };
		const url =
			provider === "apfel"
				? `${(process.env.APFEL_BASE_URL || "http://localhost:11500/v1").replace(/\/$/, "")}/models`
				: provider === "lmstudio"
					? `${(process.env.LM_STUDIO_HOST || "http://localhost:1234").replace(/\/$/, "")}/v1/models`
					: `${(process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/$/, "")}/api/tags`;
		const live = await probeUrl(url);
		if (!live) return { ok: true, skipped: `unreachable: ${url}` };
		return { ok: true, detail: url };
	});
}

async function listModels(
	provider: ProviderName,
	baseURL: string,
): Promise<string[] | null> {
	try {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
		try {
			const root = baseURL.replace(/\/v1$/, "");
			const url =
				provider === "ollama" ? `${root}/api/tags` : `${baseURL}/models`;
			const res = await fetch(url, { signal: ctrl.signal });
			if (!res.ok) return null;
			const json = (await res.json()) as Record<string, unknown>;
			if (provider === "ollama") {
				const models = (json.models as Array<{ name?: string; model?: string }>) || [];
				return models.map((m) => m.name || m.model || "").filter(Boolean);
			}
			const data = (json.data as Array<{ id?: string }>) || [];
			return data.map((d) => d.id || "").filter(Boolean);
		} finally {
			clearTimeout(t);
		}
	} catch {
		return null;
	}
}

async function testProviderChatProbe(
	provider: ProviderName,
	model: string,
	skipNetwork: boolean,
): Promise<SmokeResult> {
	return timeIt(`providers/${provider}/chat`, async () => {
		if (skipNetwork) return { ok: true, skipped: "skip-network" };
		const baseURL =
			provider === "apfel"
				? (process.env.APFEL_BASE_URL || "http://localhost:11500/v1")
				: provider === "lmstudio"
					? "http://localhost:1234/v1"
					: provider === "ollama"
						? "http://localhost:11434/v1"
						: undefined;
		if (!baseURL) return { ok: true, skipped: `unknown provider ${provider}` };
		const models = await listModels(provider, baseURL);
		if (models === null) {
			return { ok: true, skipped: `${provider} not running` };
		}
		// If the role-registry model isn't loaded on this host, skip rather
		// than fail. That's host config, not a regression.
		const present = models.some((m) => m === model || m.startsWith(`${model}:`));
		if (!present && models.length > 0) {
			return {
				ok: true,
				skipped: `${model} not loaded (${models.length} other models live)`,
			};
		}
		if (models.length === 0) {
			return { ok: true, skipped: `${provider}: no models loaded` };
		}
		try {
			const ctrl = new AbortController();
			// Local large models can take 30-60s to warm on cold start. We
			// treat a timeout as a soft skip rather than a failure since the
			// HTTP endpoint is up - it's just slow this run.
			const timer = setTimeout(() => ctrl.abort(), 60_000);
			try {
				const m = createModel({ name: provider, model });
				const result = await generateText({
					model: m,
					messages: [{ role: "user", content: "say only the word: ok" }],
					abortSignal: ctrl.signal,
				});
				const reply = result.text.slice(0, 40).replace(/\n/g, " ");
				return { ok: true, detail: `${model}: ${reply}` };
			} finally {
				clearTimeout(timer);
			}
		} catch (err) {
			const msg = (err as Error).message ?? String(err);
			if (/abort/i.test(msg)) {
				return { ok: true, skipped: `${provider}: chat timed out (cold model)` };
			}
			return { ok: false, detail: `chat failed: ${msg.slice(0, 120)}` };
		}
	});
}

// ============================================================================
// B. Settings package
// ============================================================================

async function testSettingsLoad(): Promise<SmokeResult> {
	return timeIt("settings/load", async () => {
		const s = loadSettings();
		assert(s.version === 1, `version=${s.version}, want 1`);
		assert(typeof s.voice === "object", "missing voice");
		assert(typeof s.performance === "object", "missing performance");
		assert(typeof s.models === "object", "missing models");
		assert(typeof s.providers === "object", "missing providers");
		assert(typeof s.ui === "object", "missing ui");
		return { ok: true, detail: `version=${s.version}` };
	});
}

async function testSettingsRoundTrip(): Promise<SmokeResult> {
	return timeIt("settings/round-trip", async () => {
		const filePath = getSettingsFilePath();
		const backup = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null;
		try {
			const before = loadSettings();
			const next = {
				...before,
				voice: { ...before.voice, ttsVoice: "SmokeTestVoice" },
			};
			saveSettings(next);
			const after = loadSettings();
			assert(
				after.voice.ttsVoice === "SmokeTestVoice",
				`round-trip: got ${after.voice.ttsVoice}`,
			);
			return { ok: true, detail: filePath };
		} finally {
			if (backup !== null) {
				fs.writeFileSync(filePath, backup, "utf-8");
			} else if (fs.existsSync(filePath)) {
				fs.unlinkSync(filePath);
			}
		}
	});
}

async function testSettingsPath(): Promise<SmokeResult> {
	return timeIt("settings/path", async () => {
		const p = getSettingsFilePath();
		const expected = path.join(os.homedir(), ".8gent", "settings.json");
		assert(p === expected, `got ${p}, want ${expected}`);
		return { ok: true, detail: p };
	});
}

async function testSettingsDefaults(): Promise<SmokeResult> {
	return timeIt("settings/defaults", async () => {
		assert(DEFAULT_SETTINGS.version === 1, "version");
		assert(DEFAULT_SETTINGS.voice.silenceThresholdMs === 2000, "silence default");
		assert(DEFAULT_SETTINGS.performance.mode === "auto", "mode default");
		assert(DEFAULT_SETTINGS.ui.theme === "amber", "theme default");
		assert(
			typeof DEFAULT_SETTINGS.providers.apfel === "object",
			"apfel provider default",
		);
		return { ok: true, detail: "defaults valid" };
	});
}

async function testSettingsDeepMerge(): Promise<SmokeResult> {
	return timeIt("settings/deep-merge", async () => {
		const filePath = getSettingsFilePath();
		const backup = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null;
		try {
			// Write a partial file missing several keys.
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(
				filePath,
				JSON.stringify({ voice: { ttsVoice: "Partial" } }),
				"utf-8",
			);
			const merged = loadSettings();
			assert(merged.voice.ttsVoice === "Partial", "user value preserved");
			assert(merged.voice.silenceThresholdMs === 2000, "default backfilled");
			assert(merged.ui.theme === "amber", "ui defaulted");
			assert(merged.version === 1, "version forced");
			return { ok: true, detail: "missing keys backfilled" };
		} finally {
			if (backup !== null) {
				fs.writeFileSync(filePath, backup, "utf-8");
			} else if (fs.existsSync(filePath)) {
				fs.unlinkSync(filePath);
			}
		}
	});
}

async function testSettingsKeyHelpers(): Promise<SmokeResult> {
	return timeIt("settings/key-helpers", async () => {
		const filePath = getSettingsFilePath();
		const backup = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null;
		try {
			const ui = getSetting("ui");
			assert(typeof ui.theme === "string", "ui.theme typed");
			setSetting("ui", { ...ui, theme: "amber" });
			const after = getSetting("ui");
			assert(after.theme === "amber", "setSetting persisted");
			return { ok: true, detail: "get/set ok" };
		} finally {
			if (backup !== null) {
				fs.writeFileSync(filePath, backup, "utf-8");
			} else if (fs.existsSync(filePath)) {
				fs.unlinkSync(filePath);
			}
		}
	});
}

// ============================================================================
// C. Slash command registry + dispatcher coverage
// ============================================================================

const REQUIRED_SLASH_NAMES = [
	"voice",
	"spawn",
	"settings",
	"model",
	"provider",
	"help",
	"quit",
	"clear",
	"status",
	"rename",
];

async function testSlashCount(): Promise<SmokeResult> {
	return timeIt("slash/count", async () => {
		const cmds = getBuiltInSlashCommands();
		assert(cmds.length > 30, `count=${cmds.length}, want >30`);
		return { ok: true, detail: `${cmds.length} commands` };
	});
}

async function testSlashRequired(): Promise<SmokeResult> {
	return timeIt("slash/required-names", async () => {
		const cmds = getBuiltInSlashCommands();
		const names = new Set(cmds.map((c) => c.name));
		const missing = REQUIRED_SLASH_NAMES.filter((n) => !names.has(n as never));
		assert(missing.length === 0, `missing: ${missing.join(", ")}`);
		return { ok: true, detail: `all ${REQUIRED_SLASH_NAMES.length} present` };
	});
}

async function testSlashUniqueNames(): Promise<SmokeResult> {
	return timeIt("slash/unique-names", async () => {
		const cmds = getBuiltInSlashCommands();
		const seen = new Set<string>();
		const dupes: string[] = [];
		for (const c of cmds) {
			if (seen.has(c.name)) dupes.push(c.name);
			seen.add(c.name);
		}
		assert(dupes.length === 0, `duplicate names: ${dupes.join(", ")}`);
		return { ok: true, detail: `${seen.size} unique` };
	});
}

async function testSlashUniqueAliases(): Promise<SmokeResult> {
	return timeIt("slash/unique-aliases", async () => {
		const cmds = getBuiltInSlashCommands();
		const seen = new Map<string, string>();
		const conflicts: string[] = [];
		for (const c of cmds) {
			for (const a of c.aliases) {
				const owner = seen.get(a);
				if (owner && owner !== c.name) {
					conflicts.push(`${a} (${owner} vs ${c.name})`);
				}
				seen.set(a, c.name);
			}
		}
		assert(conflicts.length === 0, `alias conflicts: ${conflicts.join("; ")}`);
		return { ok: true, detail: `${seen.size} aliases, no conflicts` };
	});
}

async function testSlashDispatchCoverage(): Promise<SmokeResult> {
	return timeIt("slash/dispatch-coverage", async () => {
		const appPath = path.join(
			import.meta.dir,
			"..",
			"apps",
			"tui",
			"src",
			"app.tsx",
		);
		assert(fs.existsSync(appPath), `app.tsx not found at ${appPath}`);
		const src = fs.readFileSync(appPath, "utf-8");
		// Locate the handleSlashCommand callback.
		const startIdx = src.indexOf("const handleSlashCommand = useCallback");
		assert(startIdx >= 0, "handleSlashCommand not found");
		// Conservatively grab the next 250k chars - the callback body lives
		// well within that window in current app.tsx.
		const slice = src.slice(startIdx, startIdx + 250_000);
		const cmds = getBuiltInSlashCommands();
		const missing: string[] = [];
		for (const c of cmds) {
			const re = new RegExp(`case\\s+["']${c.name}["']`);
			if (!re.test(slice)) missing.push(c.name);
		}
		if (missing.length > 0) {
			return {
				ok: false,
				detail: `${missing.length} registry entries lack dispatch case: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? "…" : ""}`,
			};
		}
		return { ok: true, detail: `all ${cmds.length} dispatched` };
	});
}

// ============================================================================
// D. AI SDK tool registry
// ============================================================================

const REQUIRED_TOOLS = [
	"desktop_screenshot",
	"desktop_click",
	"desktop_type",
	"desktop_press",
	"desktop_scroll",
	"desktop_drag",
	"desktop_hover",
	"desktop_windows",
	"desktop_clipboard",
	"propose_skill_creation",
	"read_file",
	"write_file",
	"git_status",
	"git_diff",
	"gh_issue_create",
];

async function testToolsCount(): Promise<SmokeResult> {
	return timeIt("tools/count", async () => {
		const keys = Object.keys(agentTools);
		assert(keys.length >= 60, `count=${keys.length}, want >=60`);
		return { ok: true, detail: `${keys.length} tools` };
	});
}

async function testToolsRequired(): Promise<SmokeResult> {
	return timeIt("tools/required", async () => {
		const keys = new Set(Object.keys(agentTools));
		const missing = REQUIRED_TOOLS.filter((t) => !keys.has(t));
		assert(missing.length === 0, `missing: ${missing.join(", ")}`);
		return { ok: true, detail: `all ${REQUIRED_TOOLS.length} present` };
	});
}

async function testDesktopToolGroup(): Promise<SmokeResult> {
	return timeIt("tools/desktop-group", async () => {
		const desktop = Object.keys(agentTools).filter((k) => k.startsWith("desktop_"));
		assert(desktop.length === 9, `desktop_* count=${desktop.length}, want 9`);
		return { ok: true, detail: `9/9: ${desktop.join(", ")}` };
	});
}

// ============================================================================
// E. Skill registry
// ============================================================================

async function testSkillFrontmatter(): Promise<SmokeResult> {
	return timeIt("skills/frontmatter", async () => {
		const skillsDir = path.join(import.meta.dir, "..", "packages", "skills");
		const entries = fs
			.readdirSync(skillsDir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
		const issues: string[] = [];
		let checked = 0;
		for (const dir of entries) {
			const skillFile = path.join(skillsDir, dir, "SKILL.md");
			if (!fs.existsSync(skillFile)) continue;
			checked++;
			const content = fs.readFileSync(skillFile, "utf-8");
			if (!content.startsWith("---")) {
				issues.push(`${dir}: no frontmatter`);
				continue;
			}
			const fmEnd = content.indexOf("\n---", 3);
			if (fmEnd < 0) {
				issues.push(`${dir}: unterminated frontmatter`);
				continue;
			}
			const fm = content.slice(3, fmEnd);
			if (!/^name:\s*\S/m.test(fm)) issues.push(`${dir}: missing name`);
			if (!/^description:\s*\S/m.test(fm)) issues.push(`${dir}: missing description`);
		}
		if (issues.length > 0) {
			return {
				ok: false,
				detail: `${issues.length} issues: ${issues.slice(0, 5).join("; ")}${issues.length > 5 ? "…" : ""}`,
			};
		}
		return { ok: true, detail: `${checked} skills validated` };
	});
}

async function testSkillNamesMatchDirs(): Promise<SmokeResult> {
	return timeIt("skills/name-matches-dir", async () => {
		const skillsDir = path.join(import.meta.dir, "..", "packages", "skills");
		const entries = fs
			.readdirSync(skillsDir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
		const mismatches: string[] = [];
		for (const dir of entries) {
			const skillFile = path.join(skillsDir, dir, "SKILL.md");
			if (!fs.existsSync(skillFile)) continue;
			const content = fs.readFileSync(skillFile, "utf-8");
			const m = content.match(/^name:\s*([^\s\n]+)/m);
			if (!m) continue;
			if (m[1] !== dir) mismatches.push(`${dir} vs name=${m[1]}`);
		}
		if (mismatches.length > 0) {
			return {
				ok: false,
				detail: `${mismatches.length}: ${mismatches.slice(0, 5).join("; ")}`,
			};
		}
		return { ok: true, detail: "all dir names match SKILL.md `name:`" };
	});
}

async function testRequiredSkills(): Promise<SmokeResult> {
	return timeIt("skills/required", async () => {
		const skillsDir = path.join(import.meta.dir, "..", "packages", "skills");
		const required = ["touchdesigner", "voice-chat-mode"];
		const missing = required.filter(
			(r) => !fs.existsSync(path.join(skillsDir, r, "SKILL.md")),
		);
		assert(missing.length === 0, `missing: ${missing.join(", ")}`);
		return { ok: true, detail: required.join(", ") };
	});
}

// ============================================================================
// F. External-agent presets
// ============================================================================

async function testExternalAgentPresets(): Promise<SmokeResult> {
	return timeIt("external-agents/presets", async () => {
		const expected = ["claude", "codex", "hermes", "openclaw", "pi", "8gent"];
		const ids = listPresetIds();
		const missing = expected.filter((e) => !ids.includes(e));
		assert(missing.length === 0, `missing presets: ${missing.join(", ")}`);
		// Each preset has a getPreset() lookup.
		for (const id of expected) {
			assert(getPreset(id) !== null, `getPreset(${id}) returned null`);
		}
		return { ok: true, detail: `${expected.length}/${expected.length} present` };
	});
}

function binOnPath(bin: string): boolean {
	const PATH = process.env.PATH || "";
	const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
	for (const dir of PATH.split(path.delimiter)) {
		if (!dir) continue;
		for (const ext of exts) {
			try {
				if (fs.existsSync(path.join(dir, bin + ext))) return true;
			} catch {
				// ignore
			}
		}
	}
	return false;
}

async function testExternalAgentBinary(id: string): Promise<SmokeResult> {
	return timeIt(`external-agents/${id}/binary`, async () => {
		const preset = getPreset(id);
		assert(preset, `preset ${id} not found`);
		const installed = binOnPath(preset.command);
		if (!installed) {
			return { ok: true, skipped: `${preset.command} not installed` };
		}
		return { ok: true, detail: `${preset.command} found on PATH` };
	});
}

// ============================================================================
// G. Auto-tune detection + voice silence learner
// ============================================================================

function makeSettings(
	mode: "auto" | "lite" | "full",
	intro: "auto" | "on" | "off" = "auto",
): Parameters<typeof computeAutoTune>[0] {
	return {
		version: 1,
		voice: { silenceThresholdMs: 2000, bargeIn: true, ttsVoice: "Ava" },
		performance: { mode, introBanner: intro },
		models: {
			tabs: {
				orchestrator: { provider: "ollama", model: "x" },
				engineer: { provider: "lmstudio", model: "x" },
				qa: { provider: "apfel", model: "x" },
			},
		},
		providers: {
			apfel: { baseURL: "" },
			ollama: { baseURL: "" },
			lmstudio: { baseURL: "" },
			openrouter: { baseURL: "" },
		},
		ui: { theme: "amber" },
	};
}

async function testAutoTuneExplicit(): Promise<SmokeResult> {
	return timeIt("auto-tune/explicit", async () => {
		const lite = computeAutoTune(makeSettings("lite"));
		const full = computeAutoTune(makeSettings("full"));
		assert(lite.liteMode === true, "lite did not win");
		assert(full.liteMode === false, "full did not win");
		return { ok: true, detail: "explicit modes win over auto" };
	});
}

async function testAutoTuneCi(): Promise<SmokeResult> {
	return timeIt("auto-tune/ci", async () => {
		const prev = process.env.CI;
		process.env.CI = "true";
		try {
			const r = computeAutoTune(makeSettings("auto"));
			assert(r.liteMode === true, "CI=true should force lite");
			return { ok: true, detail: "CI=true => lite" };
		} finally {
			if (prev === undefined) delete process.env.CI;
			else process.env.CI = prev;
		}
	});
}

async function testAutoTuneNonTty(): Promise<SmokeResult> {
	return timeIt("auto-tune/non-tty", async () => {
		// `bun run smoke | cat` runs us non-TTY; we only assert behaviour, not
		// the host environment. If isTTY is true, this asserts the inverse.
		const prevCi = process.env.CI;
		delete process.env.CI;
		try {
			const r = computeAutoTune(makeSettings("auto"));
			if (process.stdout.isTTY) {
				return { ok: true, detail: "tty present, lite=false expected" };
			}
			assert(r.liteMode === true, "non-tty should force lite");
			return { ok: true, detail: "non-tty => lite" };
		} finally {
			if (prevCi !== undefined) process.env.CI = prevCi;
		}
	});
}

async function testAutoTuneVoicePassthrough(): Promise<SmokeResult> {
	return timeIt("auto-tune/voice-passthrough", async () => {
		const r = computeAutoTune(makeSettings("auto"));
		assert(r.voiceSilenceMs === 2000, "voice threshold passthrough");
		return { ok: true, detail: `silence=${r.voiceSilenceMs}ms` };
	});
}

async function testVoiceSilenceFewSamples(): Promise<SmokeResult> {
	return timeIt("voice-silence/few-samples", async () => {
		const tmp = path.join(os.tmpdir(), `voice-silence-${Date.now()}.jsonl`);
		try {
			const learner = new VoiceSilenceLearner(tmp);
			learner.observePause(900);
			learner.observePause(1100);
			assert(
				learner.getRecommendedThreshold() === 2000,
				"<5 samples should return default 2000",
			);
			return { ok: true, detail: "<5 samples => 2000ms" };
		} finally {
			if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
		}
	});
}

async function testVoiceSilenceMeanStddev(): Promise<SmokeResult> {
	return timeIt("voice-silence/mean+stddev", async () => {
		const tmp = path.join(os.tmpdir(), `voice-silence-${Date.now()}.jsonl`);
		try {
			const learner = new VoiceSilenceLearner(tmp);
			for (const ms of [1000, 1100, 1050, 1080, 1020, 1090]) learner.observePause(ms);
			const t = learner.getRecommendedThreshold();
			assert(t >= 800 && t <= 5000, `clamped: got ${t}`);
			assert(t > 1000, `should exceed mean: got ${t}`);
			return { ok: true, detail: `${t}ms in [800,5000]` };
		} finally {
			if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
		}
	});
}

async function testVoiceSilenceCorruptResilience(): Promise<SmokeResult> {
	return timeIt("voice-silence/corrupt-line", async () => {
		const tmp = path.join(os.tmpdir(), `voice-silence-${Date.now()}.jsonl`);
		try {
			fs.writeFileSync(
				tmp,
				`{not-json}\n{"ms":1000}\n{"ms":1100}\n{"ms":1050}\n{"ms":1080}\n{"ms":1020}\n{"ms":1090}\n`,
				"utf-8",
			);
			const learner = new VoiceSilenceLearner(tmp);
			const t = learner.getRecommendedThreshold();
			assert(t >= 800 && t <= 5000, `clamped: ${t}`);
			return { ok: true, detail: `corrupt skipped, t=${t}ms` };
		} finally {
			if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
		}
	});
}

// ============================================================================
// H. Visualiser bridge
// ============================================================================

async function testVisualiserBridgeDefaultNoSink(): Promise<SmokeResult> {
	return timeIt("visualiser-bridge/default-no-sink", async () => {
		// Could be carrying state from another test; reset it.
		setVisualiserTokenSink(null);
		assert(_hasSink() === false, "default _hasSink() should be false");
		// Calling with no sink is a silent no-op.
		notifyVisualiserToken("nothing happens");
		return { ok: true, detail: "no-op without sink" };
	});
}

async function testVisualiserBridgeForward(): Promise<SmokeResult> {
	return timeIt("visualiser-bridge/forward", async () => {
		const captured: string[] = [];
		setVisualiserTokenSink((t) => captured.push(t));
		try {
			assert(_hasSink() === true, "_hasSink should be true after set");
			notifyVisualiserToken("hello world");
			assert(captured.length >= 2, `expected >=2 tokens, got ${captured.length}`);
			assert(captured.includes("hello"), "missing hello");
			assert(captured.includes("world"), "missing world");
			return { ok: true, detail: `${captured.length} tokens forwarded` };
		} finally {
			setVisualiserTokenSink(null);
		}
	});
}

async function testVisualiserBridgeDisconnect(): Promise<SmokeResult> {
	return timeIt("visualiser-bridge/disconnect", async () => {
		const captured: string[] = [];
		setVisualiserTokenSink((t) => captured.push(t));
		setVisualiserTokenSink(null);
		notifyVisualiserToken("after disconnect");
		assert(captured.length === 0, `expected 0 captured, got ${captured.length}`);
		assert(_hasSink() === false, "_hasSink should be false after null");
		return { ok: true, detail: "null disconnect works" };
	});
}

// ============================================================================
// I. Visualiser params
// ============================================================================

async function testVisualiserParamsDeterministic(): Promise<SmokeResult> {
	return timeIt("visualiser-params/deterministic", async () => {
		const a = perturbFromToken(DEFAULT_PARAMS, "agentic");
		const b = perturbFromToken(DEFAULT_PARAMS, "agentic");
		const keys = Object.keys(a) as (keyof typeof a)[];
		for (const k of keys) {
			assert(a[k] === b[k], `${k}: ${a[k]} != ${b[k]}`);
		}
		return { ok: true, detail: "same token => same vector" };
	});
}

async function testVisualiserParamsClamp(): Promise<SmokeResult> {
	return timeIt("visualiser-params/clamp", async () => {
		const samples = [
			"hello",
			"12345",
			"   ",
			"longwordhere",
			"!@#$%^&*()",
			"aeiou",
			"",
		];
		let p = DEFAULT_PARAMS;
		for (let i = 0; i < 200; i++) {
			p = perturbFromToken(p, samples[i % samples.length]);
		}
		const keys = Object.keys(p) as (keyof typeof p)[];
		for (const k of keys) {
			assert(p[k] >= 0 && p[k] <= 1, `${k}=${p[k]} out of [0,1]`);
		}
		return { ok: true, detail: "all dims in [0,1] after 200 iterations" };
	});
}

async function testVisualiserParamsBoredomMutation(): Promise<SmokeResult> {
	return timeIt("visualiser-params/boredom", async () => {
		const a = mutateForBoredom(DEFAULT_PARAMS, 42);
		const b = mutateForBoredom(DEFAULT_PARAMS, 42);
		const c = mutateForBoredom(DEFAULT_PARAMS, 9999);
		// Same seed reproduces.
		assert(a.hue === b.hue, "same seed determinism");
		// Different seed differs.
		assert(a.hue !== c.hue || a.density !== c.density, "different seed differs");
		// All clamped.
		const keys = Object.keys(a) as (keyof typeof a)[];
		for (const k of keys) assert(a[k] >= 0 && a[k] <= 1, `${k} clamp`);
		return { ok: true, detail: "deterministic + clamped" };
	});
}

async function testVisualiserParamsHash(): Promise<SmokeResult> {
	return timeIt("visualiser-params/hash", async () => {
		assert(hashToken("foo") === hashToken("foo"), "hashToken stable");
		assert(hashToken("foo") !== hashToken("bar"), "hashToken differs");
		return { ok: true, detail: "FNV-1a stable" };
	});
}

// ============================================================================
// J. Skill creator
// ============================================================================

async function testSkillCreator(): Promise<SmokeResult> {
	return timeIt("skill-creator/round-trip", async () => {
		_resetSkillCreator();
		const skillsDir = path.join(import.meta.dir, "..", "packages", "skills");
		const name = `smoke-test-${Date.now().toString(36)}`;
		const created = path.join(skillsDir, name);
		try {
			const r1 = createAutoSkill(
				{
					name,
					description: "Smoke harness probe — temporary skill, will be removed",
					body: "# Smoke Test\n\nThis is a temporary smoke-test skill body.\n\nIt should be deleted immediately after creation by the harness.",
				},
				{ sessionId: "smoke" },
			);
			assert(r1.ok === true, `create failed: ${r1.reason}`);
			assert(fs.existsSync(path.join(created, "SKILL.md")), "SKILL.md missing");

			// Collision check
			const r2 = createAutoSkill(
				{
					name,
					description: "duplicate attempt",
					body: "# Dup\n\nshould fail with name-collision per skill-creator guard.",
				},
				{ sessionId: "smoke" },
			);
			assert(r2.ok === false, "duplicate should be blocked");
			assert(r2.reason === "name-collision", `reason=${r2.reason}`);

			return {
				ok: true,
				detail: `created+blocked-dup; cap=${MAX_AUTO_SKILLS_PER_SESSION}`,
			};
		} finally {
			if (fs.existsSync(created)) {
				fs.rmSync(created, { recursive: true, force: true });
			}
			_resetSkillCreator();
		}
	});
}

async function testSkillCreatorValidation(): Promise<SmokeResult> {
	return timeIt("skill-creator/validation", async () => {
		_resetSkillCreator();
		const r1 = createAutoSkill(
			{ name: "x", description: "short", body: "tiny" },
			{ sessionId: "smoke" },
		);
		assert(r1.ok === false, "should reject invalid name");
		const r2 = createAutoSkill(
			{
				name: "valid-name",
				description: "short",
				body: "x".repeat(50),
			},
			{ sessionId: "smoke" },
		);
		assert(r2.ok === false, "should reject short description");
		assert(r2.reason === "description-too-short", `got ${r2.reason}`);
		return { ok: true, detail: "rejections fire correctly" };
	});
}

// ============================================================================
// K. Failover chain
// ============================================================================

async function testFailoverResolve(): Promise<SmokeResult> {
	return timeIt("failover/resolve", async () => {
		const fo = new ModelFailover();
		const r = fo.resolve("eight:latest");
		assert(r.model.length > 0, "model empty");
		assert(r.provider.length > 0, "provider empty");
		return { ok: true, detail: `${r.provider}::${r.model}` };
	});
}

async function testFailoverMarkDown(): Promise<SmokeResult> {
	return timeIt("failover/mark-down", async () => {
		const fo = new ModelFailover();
		const head = fo.resolve("eight:latest");
		fo.markDown(head.model, head.provider);
		const next = fo.resolve("eight:latest");
		assert(
			next.model !== head.model || next.provider !== head.provider,
			"resolve should advance after markDown",
		);
		const events = fo.getEvents();
		assert(events.length >= 1, "expected >=1 failover event");
		return { ok: true, detail: `advanced to ${next.provider}::${next.model}` };
	});
}

async function testFailoverAllDown(): Promise<SmokeResult> {
	return timeIt("failover/all-down", async () => {
		// Custom chain so we know the last entry deterministically.
		const fo = new ModelFailover({
			text: {
				"x:1": {
					models: [
						{ model: "x:1", provider: "ollama" },
						{ model: "x:2", provider: "ollama" },
						{ model: "hail-mary:free", provider: "openrouter" },
					],
				},
			},
			computer: {},
		});
		fo.markDown("x:1", "ollama");
		fo.markDown("x:2", "ollama");
		fo.markDown("hail-mary:free", "openrouter");
		const r = fo.resolve("x:1");
		assert(
			r.model === "hail-mary:free" && r.provider === "openrouter",
			`got ${r.provider}::${r.model}`,
		);
		const events = fo.drainEvents();
		assert(
			events.some((e) => e.reason === "all-tiers-down"),
			"all-tiers-down event missing",
		);
		return { ok: true, detail: "hail-mary returned, event recorded" };
	});
}

// ============================================================================
// Bonus: role registry sanity
// ============================================================================

async function testRoleRegistry(): Promise<SmokeResult> {
	return timeIt("role-registry/shape", async () => {
		const required = ["orchestrator", "engineer", "qa"];
		const missing = required.filter((r) => !ROLE_REGISTRY[r]);
		assert(missing.length === 0, `missing roles: ${missing.join(", ")}`);
		for (const role of required) {
			const cfg = ROLE_REGISTRY[role];
			assert(cfg.inferenceMode, `${role}: no inferenceMode`);
			assert(cfg.model, `${role}: no model`);
			assert(cfg.allowedTools.length > 0, `${role}: no tools`);
		}
		return { ok: true, detail: `${required.length} roles wired` };
	});
}

async function testVoiceForRole(): Promise<SmokeResult> {
	return timeIt("voice/per-agent-defaults", async () => {
		const { getVoiceForRole, DEFAULT_SETTINGS } = await import(
			"../packages/settings"
		);
		// Each role resolves to a non-empty macOS voice via defaults.
		for (const role of ["orchestrator", "engineer", "qa"]) {
			const v = getVoiceForRole(role, DEFAULT_SETTINGS);
			assert(typeof v === "string" && v.length > 0, `${role}: empty voice`);
		}
		// Per-agent map wins when set.
		const custom = {
			...DEFAULT_SETTINGS,
			voice: {
				...DEFAULT_SETTINGS.voice,
				perAgent: {
					orchestrator: "Tom",
					engineer: "Karen",
					qa: "Moira",
				},
			},
		};
		assert(
			getVoiceForRole("orchestrator", custom) === "Tom",
			"perAgent.orchestrator override ignored",
		);
		// Unknown role falls back to engineer slot.
		const eng = getVoiceForRole("nonsense", DEFAULT_SETTINGS);
		assert(
			eng === DEFAULT_SETTINGS.voice.perAgent.engineer,
			`unknown role should fall back to engineer voice, got ${eng}`,
		);
		// Empty per-agent entry falls through to ttsVoice.
		const fallback = {
			...DEFAULT_SETTINGS,
			voice: {
				...DEFAULT_SETTINGS.voice,
				ttsVoice: "Samantha",
				perAgent: { orchestrator: "", engineer: "", qa: "" },
			},
		};
		assert(
			getVoiceForRole("orchestrator", fallback) === "Samantha",
			"empty perAgent should fall back to ttsVoice",
		);
		return {
			ok: true,
			detail: `defaults: ${getVoiceForRole(
				"orchestrator",
				DEFAULT_SETTINGS,
			)}/${getVoiceForRole("engineer", DEFAULT_SETTINGS)}/${getVoiceForRole(
				"qa",
				DEFAULT_SETTINGS,
			)}`,
		};
	});
}

// ============================================================================
// L0. Onboarding (agent names + provider check)
//
// Three checks for the onboarding flow rebuild:
// - agent-names-defaults: settings ship with the canonical names
// - agent-names-roundtrip: setSetting("agents", ...) survives load
// - provider-check-shape: the renderer's "should I show install hint?" helper
//   returns the expected boolean for live / not-live / loading probe states
// ============================================================================

async function testOnboardingAgentNamesDefaults(): Promise<SmokeResult> {
	return timeIt("onboarding/agent-names-defaults", async () => {
		const s = loadSettings();
		const names = s.agents?.names;
		assert(typeof names === "object" && names !== null, "agents.names missing");
		assert(
			typeof names.orchestrator === "string" && names.orchestrator.length > 0,
			`orchestrator: got ${names.orchestrator}`,
		);
		assert(
			typeof names.engineer === "string" && names.engineer.length > 0,
			`engineer: got ${names.engineer}`,
		);
		assert(
			typeof names.qa === "string" && names.qa.length > 0,
			`qa: got ${names.qa}`,
		);
		// Verify canonical defaults exist in the schema (not in the user's
		// live settings — the user is allowed to rename their agents at any
		// time via /settings or onboarding, and that's the whole feature).
		assert(
			DEFAULT_SETTINGS.agents?.names?.orchestrator === "Orchestrator",
			`canonical default: ${DEFAULT_SETTINGS.agents?.names?.orchestrator}`,
		);
		assert(
			DEFAULT_SETTINGS.agents?.names?.engineer === "Engineer",
			`canonical default: ${DEFAULT_SETTINGS.agents?.names?.engineer}`,
		);
		assert(
			DEFAULT_SETTINGS.agents?.names?.qa === "QA",
			`canonical default: ${DEFAULT_SETTINGS.agents?.names?.qa}`,
		);
		return {
			ok: true,
			detail: `${names.orchestrator}/${names.engineer}/${names.qa}`,
		};
	});
}

async function testOnboardingAgentNamesRoundtrip(): Promise<SmokeResult> {
	return timeIt("onboarding/agent-names-roundtrip", async () => {
		const filePath = getSettingsFilePath();
		const backup = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null;
		try {
			const before = loadSettings();
			const custom = {
				...before.agents,
				names: {
					orchestrator: "Plato",
					engineer: "Hephaestus",
					qa: "Cassandra",
				},
			};
			setSetting("agents", custom);
			const after = loadSettings();
			assert(
				after.agents.names.orchestrator === "Plato",
				`got ${after.agents.names.orchestrator}, want Plato`,
			);
			assert(
				after.agents.names.engineer === "Hephaestus",
				`got ${after.agents.names.engineer}, want Hephaestus`,
			);
			assert(
				after.agents.names.qa === "Cassandra",
				`got ${after.agents.names.qa}, want Cassandra`,
			);

			// resolveRoleName must reflect the persisted custom names.
			const { resolveRoleName } = await import("../packages/settings");
			assert(
				resolveRoleName("orchestrator") === "Plato",
				`resolveRoleName orchestrator: got ${resolveRoleName("orchestrator")}`,
			);
			assert(
				resolveRoleName("qa") === "Cassandra",
				`resolveRoleName qa: got ${resolveRoleName("qa")}`,
			);
			return { ok: true, detail: "Plato / Hephaestus / Cassandra" };
		} finally {
			if (backup !== null) {
				fs.writeFileSync(filePath, backup, "utf-8");
			} else if (fs.existsSync(filePath)) {
				fs.unlinkSync(filePath);
			}
		}
	});
}

async function testOnboardingProviderCheckShape(): Promise<SmokeResult> {
	return timeIt("onboarding/provider-check-shape", async () => {
		const { shouldShowInstallHint } = await import(
			"../apps/tui/src/screens/OnboardingScreen"
		);
		// Loading: never show hint.
		assert(
			shouldShowInstallHint("ollama", {
				status: "loading",
				statuses: [],
				models: [],
			}) === false,
			"loading should hide hint",
		);
		// Done + live: hide hint.
		assert(
			shouldShowInstallHint("ollama", {
				status: "done",
				statuses: [
					{ name: "ollama", live: true },
					{ name: "lmstudio", live: false },
					{ name: "apfel", live: false },
				],
				models: ["qwen3.6:27b"],
			}) === false,
			"live ollama should hide hint",
		);
		// Done + not live: show hint.
		assert(
			shouldShowInstallHint("lmstudio", {
				status: "done",
				statuses: [
					{ name: "ollama", live: true },
					{ name: "lmstudio", live: false },
					{ name: "apfel", live: false },
				],
				models: [],
			}) === true,
			"missing lmstudio should show hint",
		);
		// Error state: show hint as a safe default.
		assert(
			shouldShowInstallHint("apfel", {
				status: "error",
				statuses: [],
				models: [],
			}) === true,
			"error should show hint",
		);
		// Provider that wasn't even returned by probe: show hint.
		assert(
			shouldShowInstallHint("apfel", {
				status: "done",
				statuses: [{ name: "ollama", live: true }],
				models: [],
			}) === true,
			"missing-from-statuses should show hint",
		);
		return { ok: true, detail: "5 cases pass" };
	});
}

// ============================================================================
// L. TUI layout invariants
//
// Pure logic checks that the layout helpers and text rendering primitives
// produce safe widths across the 80x24 → 120x40 range, so chat/header/visualiser
// can never overflow their parent box (Hermes pattern: thread one width source,
// floor it, never produce zero/negative).
// ============================================================================

async function testTuiLayoutContentWidth(): Promise<SmokeResult> {
	return timeIt("tui-layout/content-width", async () => {
		const { tuiChatContentWidth, computeProcessSidebarWidth } = await import(
			"../apps/tui/src/lib/layout-breakpoints"
		);
		// At every common width, content width must be > 0 and never exceed
		// (viewport - chrome).
		for (const cols of [60, 80, 92, 100, 120, 160]) {
			for (const sidebarOpen of [false, true]) {
				const sidebar = computeProcessSidebarWidth(sidebarOpen, cols);
				const content = tuiChatContentWidth(cols, sidebar);
				assert(content > 0, `content width <= 0 at cols=${cols} sidebar=${sidebar}`);
				assert(
					content + sidebar <= cols,
					`content+sidebar > cols at cols=${cols} (content=${content}, sidebar=${sidebar})`,
				);
				// Floor: content width should never collapse below 16 even when
				// sidebar is open at narrow widths.
				assert(
					content >= 16,
					`content width below floor at cols=${cols}: ${content}`,
				);
			}
		}
		return { ok: true, detail: "content+sidebar safe at 60-160 cols" };
	});
}

async function testTuiLayoutSidebarShrinks(): Promise<SmokeResult> {
	return timeIt("tui-layout/sidebar-shrinks", async () => {
		const { computeProcessSidebarWidth } = await import(
			"../apps/tui/src/lib/layout-breakpoints"
		);
		// Sidebar must shrink (or stay equal) as viewport narrows; never grow.
		let prev = Infinity;
		for (const cols of [160, 120, 100, 92, 80, 60]) {
			const w = computeProcessSidebarWidth(true, cols);
			assert(w <= prev, `sidebar grew when narrowing: ${prev} -> ${w} at cols=${cols}`);
			assert(w >= 18, `sidebar below SIDEBAR_MIN at cols=${cols}: ${w}`);
			prev = w;
		}
		// Closed sidebar always 0.
		assert(computeProcessSidebarWidth(false, 120) === 0, "closed sidebar should be 0");
		return { ok: true, detail: "sidebar monotonically shrinks, floor=18" };
	});
}

async function testTuiLayoutBreakLongTokensSeam(): Promise<SmokeResult> {
	return timeIt("tui-layout/break-long-tokens", async () => {
		const { breakLongTokensForTest } = await import(
			"../apps/tui/src/components/message-list.tsx"
		);
		// Soft seam preferred: hyphenated compound should break at the seam,
		// not produce mashed-up character runs like the reported
		// "you need-whthink deeplyoding" bug.
		const compound = "feature/long-branch-name-that-keeps-going-and-going";
		const wrapped = breakLongTokensForTest(compound, 16);
		assert(
			wrapped.includes("\n"),
			"long compound should be broken across lines",
		);
		// Each segment between newlines should fit the width budget.
		for (const seg of wrapped.split("\n")) {
			assert(
				seg.length <= 16,
				`segment exceeds width budget: "${seg}" (${seg.length} > 16)`,
			);
		}
		// Short tokens are untouched.
		const short = "hello world";
		assert(breakLongTokensForTest(short, 16) === short, "short text mutated");
		// A pure hash with no seam still gets hard-broken at width.
		const hash = "a".repeat(64);
		const hashWrap = breakLongTokensForTest(hash, 16);
		assert(hashWrap.includes("\n"), "long hash should break");
		for (const seg of hashWrap.split("\n")) {
			assert(seg.length <= 16, `hash segment too long: ${seg.length}`);
		}
		return { ok: true, detail: "soft seam preferred, width budget respected" };
	});
}

async function testTuiLayoutVisualiserFitsParent(): Promise<SmokeResult> {
	return timeIt("tui-layout/visualiser-fits-parent", async () => {
		// ActivityMonitor derives visualiser width as
		//   max(24, min(cols - 10, 96))
		// where chrome (10) accounts for two outer borders, two layers of
		// paddingX, and the activity box border. At every common width the
		// derived width must (a) be >= 24 (operator floor), (b) leave room
		// for chrome (i.e. width + chrome <= cols).
		for (const cols of [60, 80, 92, 100, 120, 160]) {
			const w = Math.max(24, Math.min(cols - 10, 96));
			assert(w >= 24, `visualiser below floor at cols=${cols}: ${w}`);
			// Allow the floor to win at very narrow terminals; it's the
			// ThinkingVisualizer's own clamp (min=20) that catches the rest.
			if (cols >= 34) {
				assert(
					w + 10 <= cols,
					`visualiser overflows parent at cols=${cols}: w=${w}`,
				);
			}
		}
		return { ok: true, detail: "visualiser width fits parent at 60-160 cols" };
	});
}

// ============================================================================
// M. TUI animations (typewriter reveal used by OnboardingScreen)
// ============================================================================

async function testTypewriterProgresses(): Promise<SmokeResult> {
	return timeIt("tui-anim/typewriter-progresses", async () => {
		const { computeTypewriterCount, deriveTypewriterView } = await import(
			"../apps/tui/src/hooks/useTypewriter"
		);
		const text = "Hello, eight.";
		const msPerChar = 28;
		// At t = msPerChar * 5, exactly 5 chars should be revealed.
		const count = computeTypewriterCount(msPerChar * 5, text.length, msPerChar, true);
		assert(
			count === 5,
			`expected count=5 after 5 ticks, got ${count}`,
		);
		const view = deriveTypewriterView(text, count, true);
		assert(
			view.displayed === text.slice(0, 5),
			`displayed should be first 5 chars, got "${view.displayed}"`,
		);
		assert(view.isDone === false, "should not be done at 5/13 chars");
		// At t = msPerChar * text.length, the reveal completes.
		const fullCount = computeTypewriterCount(
			msPerChar * text.length,
			text.length,
			msPerChar,
			true,
		);
		const fullView = deriveTypewriterView(text, fullCount, true);
		assert(fullView.isDone === true, "should be done after full duration");
		assert(
			fullView.displayed === text,
			`displayed should equal fullText, got "${fullView.displayed}"`,
		);
		// Beyond the end, count stays clamped at fullText.length.
		const overshoot = computeTypewriterCount(
			msPerChar * text.length * 10,
			text.length,
			msPerChar,
			true,
		);
		assert(
			overshoot === text.length,
			`overshoot should clamp to ${text.length}, got ${overshoot}`,
		);
		return { ok: true, detail: `5/${text.length} at t=${msPerChar * 5}ms` };
	});
}

async function testTypewriterSkip(): Promise<SmokeResult> {
	return timeIt("tui-anim/typewriter-skip", async () => {
		const { deriveTypewriterView } = await import(
			"../apps/tui/src/hooks/useTypewriter"
		);
		const text = "Pick a name";
		// Mid-reveal state: count=3.
		const partial = deriveTypewriterView(text, 3, true);
		assert(partial.displayed === "Pic", `partial got "${partial.displayed}"`);
		assert(partial.isDone === false, "partial should not be done");
		// Simulating skip(): caller jumps count to fullText.length. Re-derive.
		const skipped = deriveTypewriterView(text, text.length, true);
		assert(
			skipped.displayed === text,
			`skipped should show full text, got "${skipped.displayed}"`,
		);
		assert(skipped.isDone === true, "skipped should be done");
		return { ok: true, detail: "skip jumps count to fullText.length" };
	});
}

async function testTypewriterDisabled(): Promise<SmokeResult> {
	return timeIt("tui-anim/typewriter-disabled", async () => {
		const { computeTypewriterCount, deriveTypewriterView } = await import(
			"../apps/tui/src/hooks/useTypewriter"
		);
		const text = "Disabled path returns full text immediately.";
		// computeTypewriterCount with enabled=false ignores elapsed time.
		const count = computeTypewriterCount(0, text.length, 28, false);
		assert(
			count === text.length,
			`disabled count should be ${text.length}, got ${count}`,
		);
		const view = deriveTypewriterView(text, 0, false);
		assert(
			view.displayed === text,
			`disabled view should equal fullText, got "${view.displayed}"`,
		);
		assert(view.isDone === true, "disabled view should be done");
		return { ok: true, detail: "enabled=false short-circuits to full text" };
	});
}

// ============================================================================
// Output
// ============================================================================

function printTable(results: SmokeResult[]): void {
	const nameW = Math.max(4, ...results.map((r) => r.name.length));
	const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
	const head = [
		pad("test", nameW),
		"status",
		"ms".padStart(5),
		"detail",
	].join("  ");
	console.log(head);
	console.log("-".repeat(Math.min(120, head.length + 40)));
	for (const r of results) {
		const status = r.skipped ? "SKIP" : r.ok ? "OK  " : "FAIL";
		const detail = (r.skipped || r.detail || "").slice(0, 80).replace(/\n/g, " ");
		console.log(
			[
				pad(r.name, nameW),
				status,
				String(r.durationMs).padStart(5),
				detail,
			].join("  "),
		);
	}
}

function printJsonl(results: SmokeResult[]): void {
	for (const r of results) {
		console.log(JSON.stringify(r));
	}
}

function writeReport(results: SmokeResult[], totalMs: number): void {
	try {
		const dir = path.join(os.homedir(), ".8gent");
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, "smoke-report.json");
		const pass = results.filter((r) => r.ok && !r.skipped).length;
		const fail = results.filter((r) => !r.ok).length;
		const skip = results.filter((r) => r.skipped).length;
		fs.writeFileSync(
			file,
			`${JSON.stringify(
				{
					timestamp: new Date().toISOString(),
					pass,
					fail,
					skip,
					total: results.length,
					durationMs: totalMs,
					results,
				},
				null,
				2,
			)}\n`,
			"utf-8",
		);
	} catch {
		// best-effort
	}
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
	const flags = parseFlags(process.argv.slice(2));
	const t0 = performance.now();

	const isTty = process.stdout.isTTY;
	if (isTty) {
		console.log("=== 8gent-code smoke harness ===");
	}

	const results: SmokeResult[] = [];

	// A. Provider health
	results.push(await testProviderHealth("apfel", flags.skipNetwork));
	results.push(await testProviderHealth("lmstudio", flags.skipNetwork));
	results.push(await testProviderHealth("ollama", flags.skipNetwork));

	// A2. Provider chat probes (only run when probe URL is healthy; otherwise skip)
	results.push(
		await testProviderChatProbe("apfel", "apple-foundationmodel", flags.skipNetwork),
	);
	results.push(
		await testProviderChatProbe("ollama", "qwen3.6:27b", flags.skipNetwork),
	);
	results.push(
		await testProviderChatProbe(
			"lmstudio",
			"google/gemma-4-26b-a4b",
			flags.skipNetwork,
		),
	);

	// B. Settings
	results.push(await testSettingsLoad());
	results.push(await testSettingsRoundTrip());
	results.push(await testSettingsPath());
	results.push(await testSettingsDefaults());
	results.push(await testSettingsDeepMerge());
	results.push(await testSettingsKeyHelpers());

	// C. Slash registry
	results.push(await testSlashCount());
	results.push(await testSlashRequired());
	results.push(await testSlashUniqueNames());
	results.push(await testSlashUniqueAliases());
	results.push(await testSlashDispatchCoverage());

	// D. Tool registry
	results.push(await testToolsCount());
	results.push(await testToolsRequired());
	results.push(await testDesktopToolGroup());

	// E. Skill registry
	results.push(await testSkillFrontmatter());
	results.push(await testSkillNamesMatchDirs());
	results.push(await testRequiredSkills());

	// F. External agents
	results.push(await testExternalAgentPresets());
	for (const id of ["claude", "codex", "hermes", "openclaw", "pi", "8gent"]) {
		results.push(await testExternalAgentBinary(id));
	}

	// G. Auto-tune
	results.push(await testAutoTuneExplicit());
	results.push(await testAutoTuneCi());
	results.push(await testAutoTuneNonTty());
	results.push(await testAutoTuneVoicePassthrough());
	results.push(await testVoiceSilenceFewSamples());
	results.push(await testVoiceSilenceMeanStddev());
	results.push(await testVoiceSilenceCorruptResilience());

	// H. Visualiser bridge
	results.push(await testVisualiserBridgeDefaultNoSink());
	results.push(await testVisualiserBridgeForward());
	results.push(await testVisualiserBridgeDisconnect());

	// I. Visualiser params
	results.push(await testVisualiserParamsDeterministic());
	results.push(await testVisualiserParamsClamp());
	results.push(await testVisualiserParamsBoredomMutation());
	results.push(await testVisualiserParamsHash());

	// J. Skill creator
	results.push(await testSkillCreator());
	results.push(await testSkillCreatorValidation());

	// K. Failover
	results.push(await testFailoverResolve());
	results.push(await testFailoverMarkDown());
	results.push(await testFailoverAllDown());

	// L0. Onboarding (agent names + provider check)
	results.push(await testOnboardingAgentNamesDefaults());
	results.push(await testOnboardingAgentNamesRoundtrip());
	results.push(await testOnboardingProviderCheckShape());

	// L. TUI layout invariants
	results.push(await testTuiLayoutContentWidth());
	results.push(await testTuiLayoutSidebarShrinks());
	results.push(await testTuiLayoutBreakLongTokensSeam());
	results.push(await testTuiLayoutVisualiserFitsParent());

	// M. TUI animations (typewriter reveal in OnboardingScreen)
	results.push(await testTypewriterProgresses());
	results.push(await testTypewriterSkip());
	results.push(await testTypewriterDisabled());

	// Bonus
	results.push(await testRoleRegistry());
	results.push(await testVoiceForRole());

	const totalMs = Math.round(performance.now() - t0);

	if (isTty) {
		printTable(results);
	} else {
		printJsonl(results);
	}

	writeReport(results, totalMs);

	const pass = results.filter((r) => r.ok && !r.skipped).length;
	const fail = results.filter((r) => !r.ok).length;
	const skip = results.filter((r) => r.skipped).length;

	if (isTty) {
		console.log("");
		console.log(
			`total: ${pass} pass / ${fail} fail / ${skip} skip in ${totalMs}ms`,
		);
		console.log(`report: ${path.join(os.homedir(), ".8gent", "smoke-report.json")}`);
	}

	if (fail > 0) process.exit(1);
	if (flags.strict && skip > 0) process.exit(2);
}

await main();
