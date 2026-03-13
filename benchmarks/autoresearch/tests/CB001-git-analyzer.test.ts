import { describe, test, expect } from "bun:test";
import { resolve, join } from "node:path";
import { MockFileSystem, EXPECTED } from "../../fixtures/mock-git";

const WORK_DIR = process.env.WORK_DIR;
if (!WORK_DIR) throw new Error("WORK_DIR env required");

async function loadModules() {
  const analyzerMod = await import(resolve(join(WORK_DIR, "analyzer.ts")));
  const reporterMod = await import(resolve(join(WORK_DIR, "reporter.ts")));

  const analyze =
    analyzerMod.analyze ??
    analyzerMod.analyzeRepos ??
    analyzerMod.default?.analyze ??
    analyzerMod.default;

  const report =
    reporterMod.generateReport ??
    reporterMod.report ??
    reporterMod.formatReport ??
    reporterMod.default?.generateReport ??
    reporterMod.default;

  return { analyzerMod, reporterMod, analyze, report };
}

describe("CB001: Git Repository Analyzer", () => {
  test("discovers exactly 4 top-level repos (skips submodule)", async () => {
    const { analyze } = await loadModules();
    expect(typeof analyze).toBe("function");

    const fs = new MockFileSystem();
    const result = await Promise.resolve(analyze(fs, "/repos"));

    const repos = Array.isArray(result) ? result : result.repos ?? result.repositories;
    expect(repos).toBeTruthy();
    expect(repos.length).toBe(EXPECTED.repoCount);
  });

  test("empty repo returns zero commits without crashing", async () => {
    const { analyze } = await loadModules();
    const fs = new MockFileSystem();
    const result = await Promise.resolve(analyze(fs, "/repos"));
    const repos = Array.isArray(result) ? result : result.repos ?? result.repositories;

    const emptyRepo = repos.find(
      (r: any) =>
        (r.name ?? r.path ?? "").includes("empty") ||
        (r.name ?? r.path ?? "") === "empty-project"
    );
    expect(emptyRepo).toBeTruthy();

    const commits = emptyRepo.commits ?? emptyRepo.commitCount ?? emptyRepo.totalCommits;
    expect(commits).toBe(0);
  });

  test("commit counts match expected values", async () => {
    const { analyze } = await loadModules();
    const fs = new MockFileSystem();
    const result = await Promise.resolve(analyze(fs, "/repos"));
    const repos = Array.isArray(result) ? result : result.repos ?? result.repositories;

    for (const [name, expected] of Object.entries(EXPECTED.repos)) {
      const repo = repos.find(
        (r: any) =>
          (r.name ?? r.path ?? "").includes(name)
      );
      if (repo) {
        const commits = repo.commits ?? repo.commitCount ?? repo.totalCommits;
        expect(commits).toBe(expected.commits);
      }
    }
  });

  test("extracts correct author counts", async () => {
    const { analyze } = await loadModules();
    const fs = new MockFileSystem();
    const result = await Promise.resolve(analyze(fs, "/repos"));
    const repos = Array.isArray(result) ? result : result.repos ?? result.repositories;

    const webapp = repos.find(
      (r: any) => (r.name ?? r.path ?? "").includes("webapp")
    );
    if (webapp) {
      const authors =
        webapp.authors ??
        webapp.authorCount ??
        webapp.uniqueAuthors ??
        (webapp.authorList ?? []).length;
      const count = typeof authors === "number" ? authors : (authors ?? []).length;
      expect(count).toBe(3); // Alice, Bob, Carol
    }

    const apiServer = repos.find(
      (r: any) => (r.name ?? r.path ?? "").includes("api-server")
    );
    if (apiServer) {
      const authors =
        apiServer.authors ??
        apiServer.authorCount ??
        apiServer.uniqueAuthors ??
        (apiServer.authorList ?? []).length;
      const count = typeof authors === "number" ? authors : (authors ?? []).length;
      expect(count).toBe(2); // Dave, Eve
    }
  });

  test("identifies largest file correctly", async () => {
    const { analyze } = await loadModules();
    const fs = new MockFileSystem();
    const result = await Promise.resolve(analyze(fs, "/repos"));
    const repos = Array.isArray(result) ? result : result.repos ?? result.repositories;

    const webapp = repos.find(
      (r: any) => (r.name ?? r.path ?? "").includes("webapp")
    );
    if (webapp) {
      const largest = webapp.largestFile ?? webapp.biggestFile ?? webapp.maxFile;
      if (largest) {
        const name =
          typeof largest === "string" ? largest : largest.name ?? largest.path ?? "";
        expect(name).toContain("app.tsx");
      }
    }
  });

  test("handles detached HEAD gracefully", async () => {
    const { analyze } = await loadModules();
    const fs = new MockFileSystem();
    const result = await Promise.resolve(analyze(fs, "/repos"));
    const repos = Array.isArray(result) ? result : result.repos ?? result.repositories;

    const legacy = repos.find(
      (r: any) => (r.name ?? r.path ?? "").includes("legacy")
    );
    expect(legacy).toBeTruthy();

    // Should still have 15 commits even with detached HEAD
    const commits = legacy.commits ?? legacy.commitCount ?? legacy.totalCommits;
    expect(commits).toBe(15);

    // Branch should be null/undefined or indicate detached
    const branch = legacy.branch ?? legacy.currentBranch ?? legacy.head;
    if (branch !== undefined && branch !== null) {
      // If it reports something, it should indicate detached state
      expect(
        branch === "detached" ||
          branch === "HEAD" ||
          branch === "(detached)" ||
          branch === null ||
          branch.includes("detach")
      ).toBe(true);
    }
  });

  test("generates structured JSON report", async () => {
    const { analyze, report } = await loadModules();
    const fs = new MockFileSystem();
    const analysisResult = await Promise.resolve(analyze(fs, "/repos"));

    expect(typeof report).toBe("function");
    const reportResult = await Promise.resolve(report(analysisResult));
    expect(reportResult).toBeTruthy();

    // Should be a valid JSON structure or object
    const reportObj =
      typeof reportResult === "string"
        ? JSON.parse(reportResult)
        : reportResult;
    expect(typeof reportObj).toBe("object");
  });

  test("report sorted by commits descending", async () => {
    const { analyze, report } = await loadModules();
    const fs = new MockFileSystem();
    const analysisResult = await Promise.resolve(analyze(fs, "/repos"));
    const reportResult = await Promise.resolve(report(analysisResult));

    const reportObj =
      typeof reportResult === "string"
        ? JSON.parse(reportResult)
        : reportResult;

    const repos =
      reportObj.repos ?? reportObj.repositories ?? reportObj.results;
    if (Array.isArray(repos) && repos.length >= 2) {
      // Verify sorted by commits descending
      for (let i = 1; i < repos.length; i++) {
        const prevCommits =
          repos[i - 1].commits ?? repos[i - 1].commitCount ?? repos[i - 1].totalCommits ?? 0;
        const currCommits =
          repos[i].commits ?? repos[i].commitCount ?? repos[i].totalCommits ?? 0;
        expect(prevCommits).toBeGreaterThanOrEqual(currCommits);
      }
    }
  });

  test("computes language breakdown by extension", async () => {
    const { analyze } = await loadModules();
    const fs = new MockFileSystem();
    const result = await Promise.resolve(analyze(fs, "/repos"));
    const repos = Array.isArray(result) ? result : result.repos ?? result.repositories;

    const webapp = repos.find(
      (r: any) => (r.name ?? r.path ?? "").includes("webapp")
    );
    if (webapp) {
      const langs =
        webapp.languages ??
        webapp.languageBreakdown ??
        webapp.extensions ??
        webapp.fileTypes;
      if (langs) {
        const langStr = JSON.stringify(langs).toLowerCase();
        // Should contain TypeScript files
        expect(
          langStr.includes("ts") ||
            langStr.includes("typescript") ||
            langStr.includes(".ts")
        ).toBe(true);
      }
    }
  });
});
