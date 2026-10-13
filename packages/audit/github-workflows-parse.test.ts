import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";

// #4114: an unquoted "name: No workspace: specifier ..." step made ci.yml
// unparseable, and GitHub silently reported every run as a zero-job failure
// for a day. Every workflow file must parse and declare a name and jobs.
function repoRoot(from: string): string {
  let dir = from;
  while (!existsSync(join(dir, ".github", "workflows"))) {
    const up = dirname(dir);
    if (up === dir) throw new Error("no .github/workflows above " + from);
    dir = up;
  }
  return dir;
}
const root = repoRoot(import.meta.dir);
const dir = join(root, ".github", "workflows");
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

describe("GitHub workflow files parse", () => {
  test("there are workflow files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    test(`${file} is valid YAML with a name and jobs`, () => {
      const doc = parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
      expect(typeof doc.name).toBe("string");
      expect(doc.jobs && typeof doc.jobs).toBe("object");
      for (const [jobId, job] of Object.entries(doc.jobs as Record<string, { steps?: unknown[] }>)) {
        for (const step of job.steps ?? []) {
          const s = step as Record<string, unknown>;
          if ("name" in s) expect(typeof s.name, `${file} job ${jobId} step name`).toBe("string");
        }
      }
    });
  }
});
