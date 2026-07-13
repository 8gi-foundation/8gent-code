import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LessonCollector,
	lessonsToGrpoPairs,
	liveDemoToLessons,
	parseLiveDemoLedger,
	parseSelfHealReport,
	selfHealToLessons,
} from "./lesson-collector";
import { KernelManager } from "./manager";

function freshRoot(): string {
	return mkdtempSync(join(tmpdir(), "lesson-collector-"));
}

// Mirrors the real ledger format written by livedemo.py: a failing check,
// its later fix, and an auto-closed re-demo entry (no cause).
const LEDGER = [
	JSON.stringify({
		surface: "brain",
		check: "dimension_roundtrip",
		status: "fail",
		open: true,
		cause: "step DELETE /brain/dimension/tmp: status 404 != 200",
		fix: "",
		ts: 1_782_295_230,
	}),
	JSON.stringify({
		surface: "brain",
		check: "dimension_roundtrip",
		status: "fixed",
		open: false,
		cause: "no remove_dimension in brain_store; no DELETE endpoint (404)",
		fix: "added brain_store.remove_dimension + DELETE endpoint + 2 tests",
		ts: 1_782_296_344,
	}),
	JSON.stringify({
		surface: "graph",
		check: "merge_nonempty",
		status: "fixed",
		open: false,
		fix: "re-demo passed (auto-closed by livedemo run)",
		ts: 1_782_296_352,
	}),
].join("\n");

// Mirrors the real buildReport format written by self-heal.ts.
const REPORT = `# self-heal report 2026-07-05

Mode: DRY-RUN (no GitHub writes).
Repos scanned: 2. Total findings: 1 (critical 0, high 1, medium 0, low 0).

## demo-repo  _(finder: agent)_

### [HIGH] Scanner follows file symlinks across a privilege boundary
- file: \`internal/walk/walk.go\`:216
- why: Non-directory entries are passed straight to the scanners with no O_NOFOLLOW guard, so a planted symlink discloses root-readable content.
- suggested fix: Lstat non-directory entries and skip symlinks; open files with O_NOFOLLOW in readBounded.

## clean-repo  _(finder: agent)_

- no findings
`;

describe("parseLiveDemoLedger", () => {
	test("parses real-shaped entries and skips malformed lines", () => {
		const entries = parseLiveDemoLedger(`${LEDGER}\nnot json\n{"surface": 42}\n`);
		expect(entries.length).toBe(3);
		expect(entries[0].check).toBe("dimension_roundtrip");
		expect(entries[1].status).toBe("fixed");
	});
});

describe("parseSelfHealReport", () => {
	test("parses findings from the buildReport markdown format", () => {
		const findings = parseSelfHealReport(REPORT);
		expect(findings.length).toBe(1);
		expect(findings[0].severity).toBe("high");
		expect(findings[0].file).toBe("internal/walk/walk.go");
		expect(findings[0].line).toBe("216");
		expect(findings[0].why).toContain("O_NOFOLLOW guard");
		expect(findings[0].suggestedFix).toContain("Lstat non-directory entries");
		expect(findings[0].reportDate).toBe("2026-07-05");
	});

	test("a repo with no findings contributes nothing", () => {
		const findings = parseSelfHealReport(
			"# self-heal report 2026-07-06\n\n## quiet-repo  _(finder: agent)_\n\n- no findings\n",
		);
		expect(findings.length).toBe(0);
	});
});

describe("liveDemoToLessons", () => {
	test("open failures become negatives, diagnosed fixes become positives", () => {
		const lessons = liveDemoToLessons(parseLiveDemoLedger(LEDGER));

		// fail -> negative, fixed(cause+fix) -> positive; the auto-closed
		// entry (fix without cause) teaches nothing and is skipped.
		expect(lessons.length).toBe(2);

		const negative = lessons.find((l) => l.polarity === "negative");
		const positive = lessons.find((l) => l.polarity === "positive");
		expect(negative?.score).toBe(0);
		expect(negative?.response).toContain("status 404 != 200");
		expect(positive?.score).toBe(1);
		expect(positive?.response).toContain("Fix: added brain_store.remove_dimension");

		// Same ref and same prompt, so they contrast.
		expect(negative?.ref).toBe(positive?.ref ?? "");
		expect(negative?.prompt).toBe(positive?.prompt ?? "");
		expect(negative?.occurredAt).toBe(1_782_295_230_000);
	});
});

describe("selfHealToLessons", () => {
	test("each finding yields a defect negative and a fix positive on one prompt", () => {
		const lessons = selfHealToLessons(parseSelfHealReport(REPORT));
		expect(lessons.length).toBe(2);

		const negative = lessons.find((l) => l.polarity === "negative");
		const positive = lessons.find((l) => l.polarity === "positive");
		expect(negative?.response).toContain("Defect:");
		expect(negative?.response).not.toContain("Fix:");
		expect(positive?.response).toContain("Fix: Lstat non-directory entries");
		expect(negative?.prompt).toBe(positive?.prompt ?? "");
		expect(negative?.ref).toBe("selfheal:internal/walk/walk.go:216");
	});
});

describe("lessonsToGrpoPairs", () => {
	test("pairs a ref's positive against its negative; unpaired refs are skipped", () => {
		const lessons = [
			...liveDemoToLessons(parseLiveDemoLedger(LEDGER)),
			...selfHealToLessons(parseSelfHealReport(REPORT)),
			// An open failure with no fix yet: negative only, must not pair.
			...liveDemoToLessons([
				{ surface: "waiting", check: "pane_renders", status: "fail", cause: "timeout", ts: 1 },
			]),
		];
		const pairs = lessonsToGrpoPairs(lessons);

		expect(pairs.length).toBe(2);
		for (const pair of pairs) {
			expect(pair.chosen).toContain("Fix:");
			expect(pair.rejected).not.toContain("Fix:");
			expect(pair.chosen_score).toBe(1);
			expect(pair.rejected_score).toBe(0);
		}
		expect(pairs.some((p) => p.session_id === "livedemo:brain:dimension_roundtrip")).toBe(true);
		expect(pairs.some((p) => p.session_id === "livedemo:waiting:pane_renders")).toBe(false);
	});
});

/** Write fixture sources into a temp dir and return LessonSources paths. */
function fixtureSources(ledger: string = LEDGER, report: string = REPORT) {
	const dir = mkdtempSync(join(tmpdir(), "lesson-sources-"));
	const liveDemoLedgerPath = join(dir, "livedemo-ledger.jsonl");
	const selfHealReportsDir = join(dir, "reports");
	writeFileSync(liveDemoLedgerPath, ledger);
	mkdirSync(selfHealReportsDir, { recursive: true });
	writeFileSync(join(selfHealReportsDir, "2026-07-05.md"), report);
	return { liveDemoLedgerPath, selfHealReportsDir };
}

describe("LessonCollector opt-in gate", () => {
	test("is OFF by default and writes nothing", () => {
		const root = freshRoot();
		const collector = new LessonCollector(root, false, fixtureSources());

		expect(collector.enabled).toBe(false);
		const result = collector.collect();

		expect(result).toEqual({ collected: 0, duplicates: 0, dropped: 0 });
		expect(existsSync(join(root, ".8gent", "kernel", "training", "lessons.jsonl"))).toBe(false);
	});
});

describe("LessonCollector collection", () => {
	test("collects both sources, persists locally, and dedupes on re-run", () => {
		const root = freshRoot();
		const collector = new LessonCollector(root, true, fixtureSources());

		const first = collector.collect();
		expect(first.collected).toBe(4); // 2 livedemo + 2 selfheal
		expect(first.dropped).toBe(0);

		const stored = collector.readLessons();
		expect(stored.length).toBe(4);
		expect(stored.filter((l) => l.polarity === "negative").length).toBe(2);
		expect(stored.filter((l) => l.polarity === "positive").length).toBe(2);

		// Nightly re-read of the same sources appends nothing new.
		const second = collector.collect();
		expect(second.collected).toBe(0);
		expect(second.duplicates).toBe(4);
		expect(collector.readLessons().length).toBe(4);
	});

	test("missing sources yield zeros without throwing", () => {
		const collector = new LessonCollector(freshRoot(), true, {
			liveDemoLedgerPath: join(freshRoot(), "missing.jsonl"),
			selfHealReportsDir: join(freshRoot(), "missing-reports"),
		});
		expect(collector.collect()).toEqual({ collected: 0, duplicates: 0, dropped: 0 });
		expect(collector.readLessons().length).toBe(0);
	});

	test("exposes real-contrast GRPO pairs from persisted lessons", () => {
		const collector = new LessonCollector(freshRoot(), true, fixtureSources());
		collector.collect();

		const pairs = collector.toGrpoPairs();
		expect(pairs.length).toBe(2);
		expect(pairs.every((p) => p.chosen !== p.rejected)).toBe(true);
	});
});

describe("LessonCollector scrubbing", () => {
	test("drops only the lesson where a secret survives redaction", () => {
		// "password = ..." survives redact() and must trip containsSecret,
		// dropping that lesson while the clean selfheal lessons still land.
		const dirtyLedger = JSON.stringify({
			surface: "auth",
			check: "login_flow",
			status: "fail",
			open: true,
			cause: "login rejected with password = hunter2supersecret",
			ts: 2,
		});
		const collector = new LessonCollector(freshRoot(), true, fixtureSources(dirtyLedger));

		const result = collector.collect();
		expect(result.dropped).toBe(1);
		expect(result.collected).toBe(2); // the selfheal pair still collects

		const onDisk = JSON.stringify(collector.readLessons());
		expect(onDisk).not.toContain("hunter2supersecret");
	});

	test("anonymizes PII before a lesson hits disk", () => {
		const piiLedger = [
			JSON.stringify({
				surface: "mail",
				check: "digest_send",
				status: "fixed",
				open: false,
				cause: "digest to bob.smith@example.com bounced",
				fix: "retry with the resolved address",
				ts: 3,
			}),
		].join("\n");
		const { liveDemoLedgerPath } = fixtureSources(piiLedger);
		const collector = new LessonCollector(freshRoot(), true, {
			liveDemoLedgerPath,
			selfHealReportsDir: join(freshRoot(), "no-reports"),
		});

		const result = collector.collect();
		expect(result.collected).toBe(1);
		expect(JSON.stringify(collector.readLessons())).not.toContain("bob.smith@example.com");
	});
});

describe("KernelManager lesson feed wiring", () => {
	test("lesson feeds are OFF by default", () => {
		const manager = new KernelManager({ projectRoot: freshRoot() });
		expect(manager.isLessonFeedsEnabled).toBe(false);
		expect(manager.collectLessons()).toEqual({ collected: 0, duplicates: 0, dropped: 0 });
	});

	test("fromProjectConfig opts in only on training_proxy.lessonFeeds: true", () => {
		const root = freshRoot();
		mkdirSync(join(root, ".8gent"), { recursive: true });
		writeFileSync(
			join(root, ".8gent", "config.json"),
			JSON.stringify({ training_proxy: { lessonFeeds: true } }),
		);

		expect(KernelManager.fromProjectConfig(root).isLessonFeedsEnabled).toBe(true);
		expect(KernelManager.fromProjectConfig(freshRoot()).isLessonFeedsEnabled).toBe(false);
	});

	test("collectLessons and getLessons round-trip through the manager", () => {
		const manager = new KernelManager({
			projectRoot: freshRoot(),
			lessonFeeds: true,
			lessonSources: fixtureSources(),
		});

		const result = manager.collectLessons();
		expect(result.collected).toBe(4);
		expect(manager.getLessons().length).toBe(4);
	});
});
