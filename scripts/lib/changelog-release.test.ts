import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, FS, insertSection, parseGitLog, renderSection, RS } from "./changelog-release";

const rec = (subject: string, body = "") => `${subject}${FS}${body}${RS}\n`;

describe("parseGitLog", () => {
  test("squash merges: title and PR number from the trailing (#N)", () => {
    expect(parseGitLog(rec("fix(mcp): restart a crashed server (#3560)"))).toEqual([
      { title: "fix(mcp): restart a crashed server", pr: 3560 },
    ]);
  });

  test("merge commits: PR number from the subject, title from the first body line", () => {
    const raw = rec("Merge pull request #646 from 8gi-foundation/docs/x", "\ndocs: security conformance\n\nmore");
    expect(parseGitLog(raw)).toEqual([{ title: "docs: security conformance", pr: 646 }]);
  });

  test("commits with no PR reference keep a null PR", () => {
    expect(parseGitLog(rec("feat: direct commit"))).toEqual([{ title: "feat: direct commit", pr: null }]);
  });

  test("release housekeeping is dropped", () => {
    const raw =
      rec("chore(release): bump version to v0.19.0") +
      rec("chore: bump version to v0.18.2 [skip ci]") +
      rec("release: v0.18.0 (#3265)") +
      rec("fix: real change (#1)");
    expect(parseGitLog(raw)).toEqual([{ title: "fix: real change", pr: 1 }]);
  });

  test("empty input gives no changes", () => {
    expect(parseGitLog("")).toEqual([]);
  });
});

describe("classify", () => {
  const c = (title: string) => classify({ title, pr: 1 });
  test("maps conventional types to Keep a Changelog headings", () => {
    expect(c("feat(tui): x").heading).toBe("Added");
    expect(c("fix: x").heading).toBe("Fixed");
    expect(c("revert: x").heading).toBe("Removed");
    expect(c("deprecate(api): x").heading).toBe("Deprecated");
    for (const t of ["docs", "chore", "ci", "refactor", "perf", "test", "build", "style"]) {
      expect(c(`${t}: x`).heading).toBe("Changed");
    }
  });
  test("security type or scope goes under Security", () => {
    expect(c("ci(security): pin actions").heading).toBe("Security");
    expect(c("fix(security): x").heading).toBe("Security");
    expect(c("security: x").heading).toBe("Security");
  });
  test("non-conventional titles go under Changed, verbatim", () => {
    expect(c("Update the readme")).toEqual({ heading: "Changed", text: "Update the readme", pr: 1, breaking: false });
  });
  test("scope is kept as a prefix, ! marks breaking", () => {
    expect(c("feat(cli)!: new flags")).toEqual({ heading: "Added", text: "cli: new flags", pr: 1, breaking: true });
  });
});

describe("renderSection", () => {
  test("groups in Keep a Changelog order and links PRs", () => {
    const out = renderSection("1.2.0", "2026-10-06", [
      { title: "fix(a): one", pr: 2 },
      { title: "feat: two", pr: 3 },
      { title: "docs: three", pr: null },
    ], "https://example.test/r");
    expect(out).toBe(
      [
        "## [1.2.0] - 2026-10-06",
        "",
        "### Added",
        "- two ([#3](https://example.test/r/pull/3))",
        "",
        "### Changed",
        "- three",
        "",
        "### Fixed",
        "- a: one ([#2](https://example.test/r/pull/2))",
        "",
      ].join("\n"),
    );
  });
  test("an empty release says so", () => {
    expect(renderSection("1.0.1", "2026-10-06", [])).toContain("No merged pull requests");
  });
});

describe("insertSection", () => {
  const base = "# Changelog\n\nintro\n\n## [Unreleased]\n\n### Fixed - old entry\n- detail\n\n## [0.18.0] - 2026-10-01\n- prior\n";
  const section = "## [0.19.0] - 2026-10-06\n\n### Fixed\n- new\n";

  test("refuses by default when hand-written notes are under Unreleased", () => {
    expect(() => insertSection(base, "0.19.0", section)).toThrow("--drop-unreleased");
  });
  test("an empty Unreleased needs no choice", () => {
    const empty = "# Changelog\n\n## [Unreleased]\n\n## [0.18.0] - 2026-10-01\n- prior\n";
    expect(insertSection(empty, "0.19.0", section)).toBe(
      "# Changelog\n\n## [Unreleased]\n\n## [0.19.0] - 2026-10-06\n\n### Fixed\n- new\n\n## [0.18.0] - 2026-10-01\n- prior\n",
    );
  });
  test("drop: hand-written Unreleased notes are discarded", () => {
    expect(insertSection(base, "0.19.0", section, "drop")).toBe(
      "# Changelog\n\nintro\n\n## [Unreleased]\n\n## [0.19.0] - 2026-10-06\n\n### Fixed\n- new\n\n## [0.18.0] - 2026-10-01\n- prior\n",
    );
  });
  test("keep: hand-written Unreleased notes move into the release", () => {
    const out = insertSection(base, "0.19.0", section, "keep");
    expect(out).toBe(
      "# Changelog\n\nintro\n\n## [Unreleased]\n\n## [0.19.0] - 2026-10-06\n\n### Fixed\n- new\n\n### Fixed - old entry\n- detail\n\n## [0.18.0] - 2026-10-01\n- prior\n",
    );
  });
  test("refuses a version that already has a section", () => {
    expect(() => insertSection(base, "0.18.0", section)).toThrow("already has a section");
  });
  test("refuses a changelog with no Unreleased heading", () => {
    expect(() => insertSection("# Changelog\n", "0.19.0", section)).toThrow("Unreleased");
  });
});

describe("CLI against a real git history", () => {
  const sh = (cwd: string, ...args: string[]) => {
    const r = spawnSync(args[0], args.slice(1), { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };

  test("reads first-parent merges since the previous tag, skipping a tag on --to", () => {
    const dir = mkdtempSync(join(tmpdir(), "changelog-release-"));
    try {
      const g = (...a: string[]) => sh(dir, "git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...a);
      g("init", "-q", "-b", "main");
      writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n- first\n");
      g("add", "-A");
      g("commit", "-q", "-m", "chore: init");
      g("tag", "v0.1.0");
      g("commit", "-q", "--allow-empty", "-m", "fix(core): squash fix (#10)");
      g("checkout", "-q", "-b", "topic");
      g("commit", "-q", "--allow-empty", "-m", "wip on branch, not a PR title");
      g("checkout", "-q", "main");
      g("merge", "-q", "--no-ff", "topic", "-m", "Merge pull request #11 from org/topic", "-m", "feat(tui): merged feature");
      g("tag", "v0.2.0");

      const cli = join(import.meta.dir, "..", "changelog-release.ts");
      const out = sh(dir, process.execPath, cli, "--version", "0.2.0", "--to", "v0.2.0", "--date", "2026-02-02", "--write");
      expect(out).toContain("### Added\n- tui: merged feature ([#11]");
      expect(out).toContain("### Fixed\n- core: squash fix ([#10]");
      expect(out).not.toContain("wip on branch");
      expect(out).not.toContain("init");
      const written = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
      expect(written).toContain("## [Unreleased]\n\n## [0.2.0] - 2026-02-02\n");
      expect(written.indexOf("## [0.2.0]")).toBeLessThan(written.indexOf("## [0.1.0]"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CLI previous-release detection", () => {
  test("a release tag on a bump commit off main starts the range at its merge-base, and old higher-version tags are ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "changelog-release-"));
    const run = (args: string[], env: Record<string, string> = {}) => {
      const r = spawnSync(args[0], args.slice(1), { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
      if (r.status !== 0) throw new Error(`${args.join(" ")}: ${r.stderr}`);
      return r.stdout;
    };
    // creatordate must differ per tag, so each step gets its own clock.
    let t = 1_700_000_000;
    const g = (...a: string[]) => {
      t += 60;
      const d = `${t} +0000`;
      return run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...a], {
        GIT_AUTHOR_DATE: d,
        GIT_COMMITTER_DATE: d,
      });
    };
    try {
      g("init", "-q", "-b", "main");
      g("commit", "-q", "--allow-empty", "-m", "chore: init");
      g("tag", "-a", "v2.1.0", "-m", "legacy line, higher version, older"); // must not be picked
      g("commit", "-q", "--allow-empty", "-m", "fix: shipped in 0.19.0 (#1)");
      // 0.19.0 is tagged on a bump commit that never reached main.
      g("checkout", "-q", "-b", "bump");
      g("commit", "-q", "--allow-empty", "-m", "chore(release): bump version to v0.19.0");
      g("tag", "-a", "v0.19.0", "-m", "v0.19.0");
      g("checkout", "-q", "main");
      g("commit", "-q", "--allow-empty", "-m", "feat: after 0.19.0 (#2)");
      const cli = join(import.meta.dir, "..", "changelog-release.ts");
      const out = run([process.execPath, cli, "--version", "0.19.1", "--date", "2026-02-02"]);
      expect(out).toContain("after 0.19.0");
      expect(out).not.toContain("shipped in 0.19.0");
      expect(out).not.toContain("init");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
