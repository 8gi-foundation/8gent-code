/**
 * #4720: one choice means no question. A local provider is down, one hosted
 * provider has a key: it is chosen, with its model from its own live list, said
 * once, saved for the next launch. Every other shape changes nothing.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";
import { ProviderManager } from "../providers";
import { autoSwitchLine, soleRunnableProvider } from "../providers/only-runnable";
import { autoSwitchTarget, persistProviderChoice, providerDoctorRows } from "./auto-provider";

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmRetry(d);
});

describe("soleRunnableProvider", () => {
	test("a local provider that is down and exactly one hosted key: that provider", () => {
		expect(soleRunnableProvider("ollama", ["minimax"])).toBe("minimax");
		expect(soleRunnableProvider("8gent", ["minimax"])).toBe("minimax");
		expect(soleRunnableProvider("lmstudio", ["openrouter"])).toBe("openrouter");
	});
	test("no hosted key, or two: nothing changes, the person is asked", () => {
		expect(soleRunnableProvider("ollama", [])).toBeNull();
		expect(soleRunnableProvider("ollama", ["minimax", "openrouter"])).toBeNull();
	});
	test("a hosted active provider is never swapped behind the person's back", () => {
		expect(soleRunnableProvider("openrouter", ["minimax"])).toBeNull();
		expect(soleRunnableProvider("minimax", ["minimax"])).toBeNull();
	});
});

describe("autoSwitchTarget", () => {
	test("takes the model from the provider's live list and words the line", async () => {
		const t = await autoSwitchTarget("ollama", {
			hosted: () => ["minimax"],
			discover: async (p) => (p === "minimax" ? ["live-model-a", "live-model-b"] : []),
		});
		expect(t).toMatchObject({ provider: "minimax", model: "live-model-a" });
		expect(t?.line).toBe(
			`Ollama is not running; using ${t?.label} live-model-a. /provider to change.`,
		);
	});
	test("an empty live list is not a switch to nothing", async () => {
		const t = await autoSwitchTarget("ollama", {
			hosted: () => ["minimax"],
			discover: async () => [],
		});
		expect(t).toBeNull();
	});
	test("the line names the engine that was down", () => {
		expect(autoSwitchLine("lmstudio", "MiniMax", "m")).toBe(
			"LM Studio is not running; using MiniMax m. /provider to change.",
		);
	});
});

describe("persistProviderChoice", () => {
	test("writes provider and model to providers.json, and a new manager reads them back", () => {
		const dir = mkdtempSync(join(tmpdir(), "8gent-persist-"));
		dirs.push(dir);
		const file = join(dir, "providers.json");
		const pm = new ProviderManager(file);
		expect(persistProviderChoice("minimax", "live-model-a", pm)).toBe(true);
		const saved = JSON.parse(readFileSync(file, "utf-8"));
		expect(saved).toMatchObject({ activeProvider: "minimax", activeModel: "live-model-a" });
		const again = new ProviderManager(file);
		expect(again.getActiveProvider().name).toBe("minimax");
		expect(again.getActiveModel()).toBe("live-model-a");
	});
	test("a name the registry does not know is not saved", () => {
		const dir = mkdtempSync(join(tmpdir(), "8gent-persist-"));
		dirs.push(dir);
		const pm = new ProviderManager(join(dir, "providers.json"));
		expect(persistProviderChoice("openrouter-free", "x", pm)).toBe(false);
	});
});

describe("providerDoctorRows", () => {
	test("lists every keyed provider with whether it answered", async () => {
		const rows = await providerDoctorRows({
			hosted: () => ["minimax", "groq"],
			probe: async (provider) =>
				provider === "minimax"
					? { provider, label: "MiniMax", state: "answered", detail: "answered, 3 models listed" }
					: { provider, label: "Groq", state: "rejected", detail: "rejected the key (HTTP 401)" },
		});
		expect(rows.map((r) => [r.provider, r.state])).toEqual([
			["minimax", "answered"],
			["groq", "rejected"],
		]);
	});
	test("no keyed provider: no rows", async () => {
		expect(await providerDoctorRows({ hosted: () => [] })).toEqual([]);
	});
});
