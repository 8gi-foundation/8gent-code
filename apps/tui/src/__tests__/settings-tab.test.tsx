/**
 * The body follows the active tab (#4588, James live on v0.20.4): /settings
 * adds a Settings tab, and selecting it, by click or by Ctrl+number, must
 * show SettingsView in place of the chat. It stayed on the previous tab's
 * content because the App drew non-chat tab bodies nowhere.
 */
import { expect, test } from "bun:test";
import * as path from "node:path";
import { runAppHarness } from "./app-driver.js";

test("Settings tab body shows SettingsView, not the previous tab, by click and by key", async () => {
	const events = await runAppHarness(path.join(import.meta.dir, "settings-tab.harness.tsx"));
	expect(events.find((e) => e.phase === "error")).toBeUndefined();
	const at = (phase: string) => events.find((e) => e.phase === phase);
	for (const phase of ["opened", "click-settings", "key-settings"]) {
		expect(at(phase)?.ok, `${phase} shows Settings`).toBeTrue();
		expect(at(phase)?.hasSettings, `${phase} has SettingsView text`).toBeTrue();
		expect(at(phase)?.hasChat, `${phase} has no chat content`).toBeFalse();
	}
	for (const phase of ["click-chat", "key-chat"]) {
		expect(at(phase)?.ok, `${phase} shows chat`).toBeTrue();
		expect(at(phase)?.hasChat, `${phase} has chat content`).toBeTrue();
		expect(at(phase)?.hasSettings, `${phase} has no SettingsView text`).toBeFalse();
	}
}, 100000);
