/**
 * A providers.json entry that is dropped at load (no valid baseUrl) used to print
 * one line per entry on every run, for providers nobody asked for (#4712). Now it is
 * said once per process, and only with DEBUG=1 or when that provider is selected.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProviderManager } from "../index";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-warn-once-"));
const make = (providers: Record<string, unknown>) => {
	const file = path.join(tmpDir, `p-${Math.random().toString(36).slice(2)}.json`);
	fs.writeFileSync(file, JSON.stringify({ providers }));
	return new ProviderManager(file);
};
const uniq = () => `stale${Math.random().toString(36).slice(2, 8)}`;
const savedDebug = process.env.DEBUG;

afterEach(() => {
	if (savedDebug === undefined) Reflect.deleteProperty(process.env, "DEBUG");
	else process.env.DEBUG = savedDebug;
});

describe("dropped declarations warn once and only when relevant", () => {
	it("prints nothing at load without DEBUG=1", () => {
		Reflect.deleteProperty(process.env, "DEBUG");
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		make({ [uniq()]: { displayName: "x" }, [uniq()]: { baseUrl: null } });
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("prints each dropped line once per process with DEBUG=1", () => {
		process.env.DEBUG = "1";
		const name = uniq();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		make({ [name]: { displayName: "x" } });
		make({ [name]: { displayName: "x" } }); // a second manager in the same process
		const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(name));
		warn.mockRestore();
		expect(lines).toHaveLength(1);
	});

	it("prints the line when that provider is selected, once, and not for others", () => {
		Reflect.deleteProperty(process.env, "DEBUG");
		const bad = uniq();
		const other = uniq();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		const pm = make({ [bad]: { displayName: "x" }, [other]: { displayName: "y" } });
		expect(warn).not.toHaveBeenCalled();
		expect(() => pm.setActiveProvider(bad)).toThrow(/Unknown provider/);
		expect(() => pm.setActiveProvider(bad)).toThrow(/Unknown provider/);
		const lines = warn.mock.calls.map((c) => String(c[0]));
		warn.mockRestore();
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(bad);
		expect(lines[0]).not.toContain(other);
	});
});
