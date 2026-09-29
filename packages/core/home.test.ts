import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { resolveHome } from "./home";

const SANDBOX = "C:/Users/Artale/tmp/sandbox-home";
const OTHER = "C:/Users/Artale/tmp/other-profile";
const ALL_PLATFORMS = ["win32", "linux", "darwin"] as const;
const POSIX_PLATFORMS = ["linux", "darwin"] as const;

describe("resolveHome precedence (explicit env + platform)", () => {
  test("EIGHT_HOME wins on every platform, including over both overrides", () => {
    for (const platform of ALL_PLATFORMS) {
      expect(resolveHome({ EIGHT_HOME: SANDBOX, HOME: "/home/u", USERPROFILE: OTHER }, platform)).toBe(SANDBOX);
    }
  });

  test("win32 prefers USERPROFILE, matching os.homedir()", () => {
    expect(resolveHome({ HOME: SANDBOX, USERPROFILE: OTHER }, "win32")).toBe(OTHER);
  });

  test("posix prefers HOME", () => {
    for (const platform of POSIX_PLATFORMS) {
      expect(resolveHome({ HOME: SANDBOX, USERPROFILE: OTHER }, platform)).toBe(SANDBOX);
    }
  });

  test("USERPROFILE is honoured on win32; posix deliberately does not consult it", () => {
    expect(resolveHome({ USERPROFILE: SANDBOX }, "win32")).toBe(SANDBOX);
    // USERPROFILE is a Windows-only concept. Consulting it on posix would move
    // existing installs (whose home comes from HOME/passwd), so the posix branch
    // falls through to os.homedir() instead.
    for (const platform of POSIX_PLATFORMS) {
      expect(resolveHome({ USERPROFILE: SANDBOX }, platform)).toBe(homedir());
    }
  });

  test("HOME is honoured on every platform when the others are unset", () => {
    for (const platform of ALL_PLATFORMS) {
      expect(resolveHome({ HOME: SANDBOX }, platform)).toBe(SANDBOX);
    }
  });

  test("empty overrides fall through instead of resolving to an empty path", () => {
    expect(resolveHome({ EIGHT_HOME: "", HOME: "", USERPROFILE: SANDBOX }, "win32")).toBe(SANDBOX);
    expect(resolveHome({ EIGHT_HOME: "", HOME: SANDBOX, USERPROFILE: "" }, "linux")).toBe(SANDBOX);
    expect(resolveHome({ EIGHT_HOME: "", HOME: "", USERPROFILE: "" }, "win32")).toBe(homedir());
    expect(resolveHome({ EIGHT_HOME: "", HOME: "", USERPROFILE: "" }, "linux")).toBe(homedir());
  });

  test("falls back to os.homedir() when no override is set", () => {
    for (const platform of ALL_PLATFORMS) {
      expect(resolveHome({}, platform)).toBe(homedir());
    }
  });
});

// Bug 2 regression: the previous per-site fallback chains degraded to a
// cwd-relative path ("" or "~") whenever HOME was unset, and the template
// literal form produced the string "undefined/...". None of those can happen
// once an unresolved home falls through to os.homedir().
describe("resolveHome() with the real process env (bug 2 regression)", () => {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, EIGHT_HOME: process.env.EIGHT_HOME };

  function withEnv(next: Partial<Record<"HOME" | "USERPROFILE" | "EIGHT_HOME", string | undefined>>, body: () => void) {
    try {
      for (const key of ["HOME", "USERPROFILE", "EIGHT_HOME"] as const) {
        const value = next[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      body();
    } finally {
      for (const key of ["HOME", "USERPROFILE", "EIGHT_HOME"] as const) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  test("EIGHT_HOME redirects even when the OS lookup would not", () => {
    withEnv({ EIGHT_HOME: SANDBOX, HOME: "/home/u", USERPROFILE: OTHER }, () => {
      expect(resolveHome()).toBe(SANDBOX);
      // os.homedir() ignores EIGHT_HOME entirely, which is why it cannot sandbox the product
      if (process.platform === "win32") expect(homedir()).not.toBe(SANDBOX);
      expect(resolveHome()).not.toBe(homedir());
    });
  });

  test("an unset HOME never resolves to a relative or 'undefined' path", () => {
    withEnv({ HOME: undefined, EIGHT_HOME: undefined, USERPROFILE: OTHER }, () => {
      const resolved = resolveHome();
      expect(resolved).toBe(process.platform === "win32" ? OTHER : homedir());
      expect(resolved).not.toContain("undefined");
      expect(resolved).not.toBe("~");
      // Absolute on every platform. A leading "/" is not the test: on POSIX an
      // unset HOME correctly falls back to os.homedir(), which is absolute and
      // does start with "/". What must never happen is a relative path, an
      // "undefined" segment, or a literal "~".
      expect(path.isAbsolute(resolved)).toBe(true);
    });
  });
});
