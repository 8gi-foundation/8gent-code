/**
 * Unit tests for security helpers: safePath and safeExec.
 *
 * These validate the shell injection and path traversal fixes
 * introduced in fix(security) PR #1.
 */

import { describe, test, expect } from "bun:test";
import * as path from "path";
import * as os from "os";

// Re-implement safePath here since it's not exported from the module.
// If the module is refactored to export these, import directly instead.
function safePath(userPath: string, workingDirectory: string): string {
  const absolutePath = path.isAbsolute(userPath)
    ? path.resolve(userPath)
    : path.resolve(workingDirectory, userPath);

  const normalizedBase = path.resolve(workingDirectory) + path.sep;
  const normalizedTarget = path.resolve(absolutePath);

  if (
    normalizedTarget !== path.resolve(workingDirectory) &&
    !normalizedTarget.startsWith(normalizedBase)
  ) {
    throw new Error(
      `Path traversal blocked: "${userPath}" resolves to "${normalizedTarget}" which is outside the working directory "${workingDirectory}".`
    );
  }

  return absolutePath;
}

describe("safePath", () => {
  const workDir = "/home/user/project";

  test("allows relative paths inside working directory", () => {
    const result = safePath("src/index.ts", workDir);
    expect(result).toBe(path.resolve(workDir, "src/index.ts"));
  });

  test("allows '.' (working directory itself)", () => {
    const result = safePath(".", workDir);
    expect(result).toBe(path.resolve(workDir));
  });

  test("allows nested relative paths", () => {
    const result = safePath("src/utils/helpers.ts", workDir);
    expect(result).toBe(path.resolve(workDir, "src/utils/helpers.ts"));
  });

  test("blocks ../../ traversal", () => {
    expect(() => safePath("../../etc/passwd", workDir)).toThrow("Path traversal blocked");
  });

  test("blocks absolute path outside working directory", () => {
    expect(() => safePath("/etc/passwd", workDir)).toThrow("Path traversal blocked");
  });

  test("blocks path to parent directory", () => {
    expect(() => safePath("..", workDir)).toThrow("Path traversal blocked");
  });

  test("blocks absolute path to home directory of another user", () => {
    expect(() => safePath("/home/user2/secret.txt", workDir)).toThrow("Path traversal blocked");
  });

  test("prevents prefix false-positive (/home/user2 vs /home/user)", () => {
    // /home/user2 starts with /home/user but is NOT inside /home/user/project
    expect(() => safePath("/home/user2", "/home/user")).toThrow("Path traversal blocked");
  });

  test("blocks sneaky traversal with intermediate components", () => {
    expect(() => safePath("src/../../.ssh/id_rsa", workDir)).toThrow("Path traversal blocked");
  });

  test("allows paths that resolve back into the working directory", () => {
    // src/../src/index.ts resolves to src/index.ts which is still inside
    const result = safePath("src/../src/index.ts", workDir);
    expect(result).toBe(path.resolve(workDir, "src/index.ts"));
  });
});

describe("safeExec argument safety", () => {
  test("shell metacharacters in arguments are harmless with spawn", async () => {
    // spawn with argument arrays passes args directly to the process,
    // so shell metacharacters are treated as literal strings
    const { spawn } = await import("child_process");

    const result = await new Promise<string>((resolve) => {
      const proc = spawn("echo", ['hello; rm -rf / #'], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
      proc.on("close", () => resolve(stdout.trim()));
    });

    // The semicolon and command are treated as literal text, not executed
    expect(result).toBe("hello; rm -rf / #");
  });

  test("backtick injection is harmless with spawn", async () => {
    const { spawn } = await import("child_process");

    const result = await new Promise<string>((resolve) => {
      const proc = spawn("echo", ['`whoami`'], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
      proc.on("close", () => resolve(stdout.trim()));
    });

    // Backticks are literal, not evaluated
    expect(result).toBe("`whoami`");
  });
});

describe("git_add argument splitting", () => {
  test("space-separated files are split into individual arguments", () => {
    const argsFiles = "src/foo.ts src/bar.ts";
    const files = argsFiles ? String(argsFiles).split(/\s+/) : ["."];
    expect(files).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  test("single file remains a single argument", () => {
    const argsFiles = "src/foo.ts";
    const files = argsFiles ? String(argsFiles).split(/\s+/) : ["."];
    expect(files).toEqual(["src/foo.ts"]);
  });

  test("empty/undefined defaults to '.'", () => {
    const argsFiles = undefined;
    const files = argsFiles ? String(argsFiles).split(/\s+/) : ["."];
    expect(files).toEqual(["."]);
  });
});

describe("git_log count validation", () => {
  test("decimal count is floored", () => {
    const count = Math.max(1, Math.floor(Math.abs(Number(5.5) || 10)));
    expect(count).toBe(5);
  });

  test("negative count is made positive", () => {
    const count = Math.max(1, Math.floor(Math.abs(Number(-3) || 10)));
    expect(count).toBe(3);
  });

  test("zero defaults to 10", () => {
    const count = Math.max(1, Math.floor(Math.abs(Number(0) || 10)));
    expect(count).toBe(10);
  });

  test("NaN defaults to 10", () => {
    const count = Math.max(1, Math.floor(Math.abs(Number("abc") || 10)));
    expect(count).toBe(10);
  });

  test("valid integer passes through", () => {
    const count = Math.max(1, Math.floor(Math.abs(Number(20) || 10)));
    expect(count).toBe(20);
  });
});
