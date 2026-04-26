/**
 * Tests for the skill-as-experiment loop (issue #1792).
 *
 * Covers:
 * 1. runExperiment with passing numeric threshold → skill kept, ledger entry
 * 2. runExperiment with failing numeric threshold → skill rolled back
 * 3. runExperiment with predicate metric (boolean measurement)
 * 4. Test callable throws → record marked failed, skill rolled back
 * 5. validateSpec rejects malformed specs
 * 6. compoundSkillWithExperiment with flag off → experiment skipped (default behaviour)
 * 7. compoundSkillWithExperiment with flag on + failure → rollback + null path
 * 8. getExperimentHistory returns chronological ledger entries
 * 9. MemorySink receives the record
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	LEARNED_SKILLS_DIR,
	compoundSkill,
	compoundSkillWithExperiment,
} from "./compound.js";
import {
	EXPERIMENTS_DIR,
	type ExperimentRecord,
	getExperimentHistory,
	runExperiment,
	setExperimentMemorySink,
	setShellTestRunner,
	validateSpec,
} from "./experiment.js";

// Each test uses a unique slug so we never collide with real learned skills.
const TEST_PREFIX = "xp-test-";

function uniqueSlug(): string {
	return `${TEST_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanupSlug(slug: string): void {
	const md = join(LEARNED_SKILLS_DIR, `${slug}.md`);
	const ledger = join(EXPERIMENTS_DIR, `${slug}.json`);
	if (existsSync(md)) unlinkSync(md);
	if (existsSync(ledger)) unlinkSync(ledger);
}

function cleanupAllTestSlugs(): void {
	for (const dir of [LEARNED_SKILLS_DIR, EXPERIMENTS_DIR]) {
		if (!existsSync(dir)) continue;
		const fs = require("node:fs") as typeof import("fs");
		for (const f of fs.readdirSync(dir)) {
			if (f.startsWith(TEST_PREFIX)) {
				try {
					unlinkSync(join(dir, f));
				} catch {
					// ignore
				}
			}
		}
	}
}

describe("runExperiment", () => {
	beforeEach(() => {
		mkdirSync(LEARNED_SKILLS_DIR, { recursive: true });
		setExperimentMemorySink(() => {});
	});

	afterEach(() => {
		cleanupAllTestSlugs();
	});

	it("keeps the skill when the numeric threshold is met", async () => {
		const slug = uniqueSlug();
		const skillPath = join(LEARNED_SKILLS_DIR, `${slug}.md`);
		writeFileSync(skillPath, "---\nname: test\n---\nbody\n");

		const record = await runExperiment(skillPath, {
			hypothesis: "The skill reduces retry count to at most 1.",
			test: async () => 0.9,
			metric: 0.8,
		});

		expect(record.passed).toBe(true);
		expect(record.rolledBack).toBe(false);
		expect(record.measurement).toBe(0.9);
		expect(existsSync(skillPath)).toBe(true);
	});

	it("rolls back the skill when the numeric threshold fails", async () => {
		const slug = uniqueSlug();
		const skillPath = join(LEARNED_SKILLS_DIR, `${slug}.md`);
		writeFileSync(skillPath, "---\nname: test\n---\nbody\n");

		const record = await runExperiment(skillPath, {
			hypothesis: "Not valuable.",
			test: async () => 0.4,
			metric: 0.8,
		});

		expect(record.passed).toBe(false);
		expect(record.rolledBack).toBe(true);
		expect(existsSync(skillPath)).toBe(false);
	});

	it("supports predicate metrics over boolean measurements", async () => {
		const slug = uniqueSlug();
		const skillPath = join(LEARNED_SKILLS_DIR, `${slug}.md`);
		writeFileSync(skillPath, "---\nname: test\n---\nbody\n");

		const record = await runExperiment(skillPath, {
			hypothesis: "Returns true.",
			test: () => true,
			metric: (m) => m === true,
		});

		expect(record.passed).toBe(true);
		expect(existsSync(skillPath)).toBe(true);
	});

	it("records a failure and rolls back when the test callable throws", async () => {
		const slug = uniqueSlug();
		const skillPath = join(LEARNED_SKILLS_DIR, `${slug}.md`);
		writeFileSync(skillPath, "---\nname: test\n---\nbody\n");

		const record = await runExperiment(skillPath, {
			hypothesis: "Should error.",
			test: async () => {
				throw new Error("boom");
			},
			metric: 1,
		});

		expect(record.passed).toBe(false);
		expect(record.rolledBack).toBe(true);
		expect(record.error).toContain("boom");
		expect(existsSync(skillPath)).toBe(false);
	});

	it("keeps the skill when a shell-command test exits 0 (issue #1818)", async () => {
		const slug = uniqueSlug();
		const skillPath = join(LEARNED_SKILLS_DIR, `${slug}.md`);
		writeFileSync(skillPath, "---\nname: test\n---\nbody\n");

		setShellTestRunner(() => ({ exitCode: 0, stderr: "" }));

		const record = await runExperiment(skillPath, {
			hypothesis: "Shell check passes.",
			test: "true",
			metric: (m) => m === 1,
		});

		expect(record.passed).toBe(true);
		expect(record.rolledBack).toBe(false);
		expect(record.measurement).toBe(1);
		expect(existsSync(skillPath)).toBe(true);
	});

	it("rolls back the skill when a shell-command test exits nonzero (issue #1818)", async () => {
		const slug = uniqueSlug();
		const skillPath = join(LEARNED_SKILLS_DIR, `${slug}.md`);
		writeFileSync(skillPath, "---\nname: test\n---\nbody\n");

		setShellTestRunner(() => ({ exitCode: 2, stderr: "boom" }));

		const record = await runExperiment(skillPath, {
			hypothesis: "Shell check fails.",
			test: "false",
			metric: (m) => m === 1,
		});

		expect(record.passed).toBe(false);
		expect(record.rolledBack).toBe(true);
		expect(record.measurement).toBe(0);
		expect(record.error).toContain("boom");
		expect(existsSync(skillPath)).toBe(false);
	});

	it("forwards the record to a registered memory sink", async () => {
		const slug = uniqueSlug();
		const skillPath = join(LEARNED_SKILLS_DIR, `${slug}.md`);
		writeFileSync(skillPath, "---\nname: test\n---\nbody\n");

		const received: ExperimentRecord[] = [];
		setExperimentMemorySink((r) => received.push(r));

		await runExperiment(skillPath, {
			hypothesis: "H",
			test: () => 2,
			metric: 1,
		});

		expect(received).toHaveLength(1);
		expect(received[0].hypothesis).toBe("H");
		expect(received[0].passed).toBe(true);
	});
});

describe("validateSpec", () => {
	it("rejects missing hypothesis", () => {
		const err = validateSpec({ hypothesis: "", test: () => 1, metric: 0 });
		expect(err).toContain("hypothesis");
	});

	it("rejects shell-command test paired with numeric threshold", () => {
		const err = validateSpec({
			hypothesis: "h",
			test: "bun run bench:foo",
			metric: 0.8,
		});
		expect(err).toContain("predicate");
	});

	it("accepts well-formed specs", () => {
		expect(
			validateSpec({ hypothesis: "h", test: () => 1, metric: 0 }),
		).toBeNull();
		expect(
			validateSpec({
				hypothesis: "h",
				test: "bun run bench:foo",
				metric: () => true,
			}),
		).toBeNull();
	});
});

describe("compoundSkillWithExperiment", () => {
	beforeEach(() => {
		mkdirSync(LEARNED_SKILLS_DIR, { recursive: true });
		process.env.SKILLS_EXPERIMENTS = undefined;
	});

	afterEach(() => {
		cleanupAllTestSlugs();
		process.env.SKILLS_EXPERIMENTS = undefined;
	});

	it("skips the experiment when SKILLS_EXPERIMENTS is not set (default)", async () => {
		const slug = uniqueSlug();
		const { path, record } = await compoundSkillWithExperiment({
			pattern: slug,
			description: "d",
			steps: ["step 1"],
			tools: ["Bash"],
			experiment: {
				hypothesis: "H",
				test: () => 0.1, // would fail if run
				metric: 0.9,
			},
		});

		expect(path).toContain(slug);
		expect(record).toBeNull();
		expect(existsSync(path!)).toBe(true);
	});

	it("runs the experiment and rolls back on failure when flag is on", async () => {
		process.env.SKILLS_EXPERIMENTS = "1";
		const slug = uniqueSlug();
		const { path, record } = await compoundSkillWithExperiment({
			pattern: slug,
			description: "d",
			steps: ["step 1"],
			tools: ["Bash"],
			experiment: {
				hypothesis: "Will fail.",
				test: () => 0.1,
				metric: 0.9,
			},
		});

		expect(path).toBeNull();
		expect(record).not.toBeNull();
		expect(record?.rolledBack).toBe(true);
		expect(existsSync(join(LEARNED_SKILLS_DIR, `${slug}.md`))).toBe(false);
	});

	it("keeps the skill and records success when flag is on and metric passes", async () => {
		process.env.SKILLS_EXPERIMENTS = "1";
		const slug = uniqueSlug();
		const { path, record } = await compoundSkillWithExperiment({
			pattern: slug,
			description: "d",
			steps: ["step 1"],
			tools: ["Bash"],
			experiment: {
				hypothesis: "Will pass.",
				test: () => 1.0,
				metric: 0.5,
			},
		});

		expect(path).not.toBeNull();
		expect(record).not.toBeNull();
		expect(record?.passed).toBe(true);
		expect(record?.rolledBack).toBe(false);
		expect(existsSync(path!)).toBe(true);
	});
});

describe("getExperimentHistory", () => {
	beforeEach(() => {
		mkdirSync(LEARNED_SKILLS_DIR, { recursive: true });
	});

	afterEach(() => {
		cleanupAllTestSlugs();
	});

	it("returns ledger entries for a given slug in chronological order", async () => {
		const slug = uniqueSlug();
		const skillPath = join(LEARNED_SKILLS_DIR, `${slug}.md`);
		writeFileSync(skillPath, "---\nname: test\n---\nbody\n");

		await runExperiment(skillPath, {
			hypothesis: "first run",
			test: () => 1,
			metric: 0,
		});

		// Recreate the skill file (first run's result = pass, so it is still there)
		await runExperiment(skillPath, {
			hypothesis: "second run",
			test: () => 2,
			metric: 0,
		});

		const history = getExperimentHistory(slug);
		expect(history.length).toBeGreaterThanOrEqual(2);
		expect(history[0].hypothesis).toBe("first run");
		expect(history[history.length - 1].hypothesis).toBe("second run");
	});
});
