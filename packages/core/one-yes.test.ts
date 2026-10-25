import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { askOneYes, askOneYesDetailed, unattended } from "./one-yes";

function rig(over: { tty?: boolean } = {}) {
	const input = Object.assign(new PassThrough(), { isTTY: over.tty ?? true });
	const output = Object.assign(new PassThrough(), { isTTY: over.tty ?? true });
	const logs: string[] = [];
	const ledger: Record<string, unknown>[] = [];
	return {
		input,
		output,
		logs,
		ledger,
		opts: {
			label: "test",
			env: {} as Record<string, string>,
			input,
			output,
			log: (l: string) => logs.push(l),
			record: (e: Record<string, unknown>) => ledger.push(e),
		},
	};
}

describe("one-yes resolver (#4919)", () => {
	test("timeout resolves to no, logs one line, records the ledger", async () => {
		const r = rig();
		const res = await askOneYesDetailed("Install mpv? [y/N]", { ...r.opts, timeoutMs: 30 });
		expect(res).toEqual({ answer: false, reason: "timeout" });
		expect(r.logs.length).toBe(1);
		expect(r.logs[0]).toContain("nobody answered");
		expect(r.ledger[0]?.label).toBe("test");
		expect(r.ledger[0]?.reason).toBe("timeout");
	});

	test("non-tty resolves to no at once, without waiting", async () => {
		const r = rig({ tty: false });
		const t0 = Date.now();
		const res = await askOneYesDetailed("Install mpv? [y/N]", { ...r.opts, timeoutMs: 5000 });
		expect(res).toEqual({ answer: false, reason: "no-tty" });
		expect(Date.now() - t0).toBeLessThan(1000);
		expect(r.logs.length).toBe(1);
		expect(r.ledger[0]?.reason).toBe("no-tty");
	});

	test("CI, EIGHT_UNATTENDED and EIGHT_HEADLESS with the default stdin are no", async () => {
		for (const k of ["CI", "EIGHT_UNATTENDED", "EIGHT_HEADLESS"]) {
			const logs: string[] = [];
			const res = await askOneYesDetailed("Run it? [y/N]", {
				label: "test",
				env: { [k]: "1" },
				log: (l) => logs.push(l),
				record: () => {},
			});
			expect(res).toEqual({ answer: false, reason: "unattended-env" });
		}
		expect(unattended({ CI: "1" }, { isTTY: true }, { isTTY: true })).toBe(true);
		expect(unattended({}, { isTTY: true }, { isTTY: true })).toBe(false);
		expect(unattended({ CI: "0" }, { isTTY: true }, { isTTY: true })).toBe(false);
	});

	test("CI=1 with an explicit stream and a typed y is still yes", async () => {
		for (const k of ["CI", "EIGHT_UNATTENDED", "EIGHT_HEADLESS"]) {
			const r = rig();
			const p = askOneYesDetailed("Run it? [y/N]", {
				...r.opts,
				env: { [k]: "1" },
				timeoutMs: 2000,
			});
			r.input.write("y\n");
			expect(await p).toEqual({ answer: true, reason: "yes" });
		}
	});

	test("an explicit yes or y inside the window is still yes", async () => {
		for (const word of ["y", "yes", "  YES "]) {
			const r = rig();
			const p = askOneYesDetailed("Allow? [y/N]", { ...r.opts, timeoutMs: 2000 });
			r.input.write(`${word}\n`);
			expect(await p).toEqual({ answer: true, reason: "yes" });
			expect(r.logs.length).toBe(0);
		}
	});

	test("no path defaults to yes: Enter, other words, closed input, errors", async () => {
		for (const line of ["\n", "n\n", "maybe\n", "yep\n", "ye\n"]) {
			const r = rig();
			const p = askOneYes("Allow? [y/N]", { ...r.opts, timeoutMs: 2000 });
			r.input.write(line);
			expect(await p).toBe(false);
		}
		const r = rig();
		const p = askOneYesDetailed("Allow? [y/N]", { ...r.opts, timeoutMs: 2000 });
		r.input.end();
		expect(await p).toEqual({ answer: false, reason: "closed-input" });
	});

	test("the timeout comes from EIGHT_ONE_YES_TIMEOUT_MS when set", async () => {
		const r = rig();
		const t0 = Date.now();
		const res = await askOneYesDetailed("Allow? [y/N]", {
			...r.opts,
			env: { EIGHT_ONE_YES_TIMEOUT_MS: "40" },
		});
		expect(res.reason).toBe("timeout");
		expect(Date.now() - t0).toBeLessThan(1500);
	});
});

describe("no one-yes prompt outside the helper (#4919)", () => {
	const root = join(import.meta.dir, "..");
	const sites = [
		"computer/desktop-approval.ts",
		"cron/scout.ts",
		"eight/judge-install.ts",
		"eight/source-update.ts",
		"eight/scripts/cua-run.ts",
		"eight/scripts/cua-setup.ts",
		"permissions/index.ts",
		"permissions/system-one-gate.ts",
	];
	for (const f of sites) {
		test(`${f} builds no readline prompt of its own`, () => {
			const src = readFileSync(join(root, f), "utf8");
			expect(src).not.toMatch(/createInterface|rl\.question|\[Y\/n\]: /);
			expect(src).not.toContain("Allow? [Y/n]");
		});
	}
});

describe("no prompt text reaches the log or the ledger (#4057, #4919)", () => {
	const MARKER = "hunter2-SECRET";
	const prompt = `Allow? will type exactly: "${MARKER}" [y/N]:`;
	const cases: [string, (r: ReturnType<typeof rig>) => Promise<unknown>][] = [
		["timeout", (r) => askOneYesDetailed(prompt, { ...r.opts, timeoutMs: 20 })],
		[
			"no-tty",
			(r) =>
				askOneYesDetailed(prompt, {
					...r.opts,
					input: Object.assign(new PassThrough(), { isTTY: false }),
				}),
		],
		[
			"unattended-env",
			(r) =>
				askOneYesDetailed(prompt, {
					label: "test",
					env: { CI: "1" },
					log: r.opts.log,
					record: r.opts.record,
				}),
		],
		[
			"closed-input",
			(r) => {
				const p = askOneYesDetailed(prompt, r.opts);
				r.input.end();
				return p;
			},
		],
		[
			"empty-answer",
			(r) => {
				const p = askOneYesDetailed(prompt, r.opts);
				r.input.write("\n");
				return p;
			},
		],
	];
	for (const [name, run] of cases) {
		test(`${name}: only label, reason and time are recorded`, async () => {
			const r = rig();
			await run(r);
			expect(r.logs.length).toBe(1);
			expect(r.ledger.length).toBe(1);
			expect(JSON.stringify(r.ledger)).not.toContain(MARKER);
			expect(r.logs.join("\n")).not.toContain(MARKER);
			expect(Object.keys(r.ledger[0] ?? {}).sort()).toEqual(["at", "event", "label", "reason"]);
			expect(r.ledger[0]?.reason).toBe(name);
		});
	}

	test("every call site passes a label", () => {
		const root = join(import.meta.dir, "..");
		const sites: [string, string][] = [
			["computer/desktop-approval.ts", "desktop-type"],
			["cron/scout.ts", "scout"],
			["eight/judge-install.ts", "judge-install"],
			["eight/source-update.ts", "source-update"],
			["eight/scripts/cua-run.ts", "cua-run"],
			["eight/scripts/cua-setup.ts", "cua-setup"],
			["permissions/index.ts", "permission"],
			["permissions/system-one-gate.ts", "system-one-escalation"],
		];
		for (const [f, label] of sites) {
			expect(readFileSync(join(root, f), "utf8")).toContain(`label: "${label}"`);
		}
	});
});
