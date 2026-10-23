import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALWAYS_BLOCKED_COMMANDS, getPermissionManager, resetPermissionManager } from "./index";
import {
	INFINITE_MODE_MAX_MS,
	createChildHolder,
	createPermissionHolder,
	effectivePermissionMode,
	runWithPermissionHolder,
	setHolderMode,
} from "./permission-mode";
import { parseYoloArgs, readYoloChoice, writeYoloChoice, yoloPrefPath } from "./yolo-pref";

const dirs: string[] = [];
const fresh = () => {
	const d = mkdtempSync(join(tmpdir(), "yolo-pref-"));
	dirs.push(d);
	return d;
};
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("remembered answer", () => {
	test("unset until asked, then yes and no persist, no file means ask", () => {
		const d = fresh();
		expect(readYoloChoice(d)).toBeUndefined();
		expect(writeYoloChoice("yes", d)).toBe(true);
		expect(readYoloChoice(d)).toBe("yes");
		writeYoloChoice("no", d);
		expect(readYoloChoice(d)).toBe("no");
		expect(JSON.parse(readFileSync(yoloPrefPath(d), "utf8")).choice).toBe("no");
	});

	test("a corrupt or unknown file reads as never asked", () => {
		const d = fresh();
		mkdirSync(d, { recursive: true });
		writeFileSync(yoloPrefPath(d), "{not json");
		expect(readYoloChoice(d)).toBeUndefined();
		writeFileSync(yoloPrefPath(d), JSON.stringify({ choice: "maybe" }));
		expect(readYoloChoice(d)).toBeUndefined();
	});

	test("an unwritable folder reports false and does not throw", () => {
		const d = fresh();
		writeFileSync(join(d, "blocker"), "x");
		expect(writeYoloChoice("yes", join(d, "blocker", "sub"))).toBe(false);
	});
});

describe("/mode yolo", () => {
	test("on, off, and nothing else", () => {
		expect(parseYoloArgs(["yolo"])).toBe("on");
		expect(parseYoloArgs(["YOLO", "on"])).toBe("on");
		expect(parseYoloArgs(["yolo off"])).toBe("off");
		expect(parseYoloArgs(["yolo", "maybe"])).toBeNull();
		expect(parseYoloArgs(["ask"])).toBeNull();
		expect(parseYoloArgs([])).toBeNull();
	});
});

describe("yolo holds Infinite for the session", () => {
	const later = Date.now() + INFINITE_MODE_MAX_MS + 1000;

	test("plain Infinite still drops to Ask after 30 minutes", () => {
		const h = createPermissionHolder("infinite");
		expect(effectivePermissionMode(h, later)).toBe("ask");
	});

	test("a yolo holder stays Infinite past 30 minutes", () => {
		const h = createPermissionHolder("infinite", undefined, Date.now(), true);
		expect(effectivePermissionMode(h, later)).toBe("infinite");
	});

	test("a child of a yolo holder inherits it, a child of plain Infinite does not", () => {
		const yolo = createPermissionHolder("infinite", undefined, Date.now(), true);
		expect(effectivePermissionMode(createChildHolder(yolo), later)).toBe("infinite");
		const plain = createPermissionHolder("infinite");
		expect(effectivePermissionMode(createChildHolder(plain), later)).toBe("ask");
	});

	test("any switch away clears it, and a plain switch back to Infinite expires again", () => {
		const h = createPermissionHolder("infinite", undefined, Date.now(), true);
		setHolderMode(h, "guarded");
		setHolderMode(h, "infinite");
		expect(h.persistent).toBeUndefined();
		expect(effectivePermissionMode(h, later)).toBe("ask");
	});
});

describe("yolo does not widen what is allowed", () => {
	test("always-blocked commands are denied and refused under a yolo holder", async () => {
		resetPermissionManager();
		const pm = getPermissionManager();
		const yolo = createPermissionHolder("infinite", undefined, Date.now(), true);
		const blocked = ALWAYS_BLOCKED_COMMANDS.map((r) => [r.command, ...r.args].join(" "));
		expect(blocked.length).toBeGreaterThan(0);
		await runWithPermissionHolder(yolo, async () => {
			for (const c of blocked) {
				expect(pm.checkPermission(c)).toBe("denied");
				expect(await pm.requestPermission("x", "y", c)).toBe(false);
			}
			// The ask-every-time list still asks a person.
			expect(pm.checkPermission("git push --force origin main")).not.toBe("allowed");
		});
		resetPermissionManager();
	});
});
