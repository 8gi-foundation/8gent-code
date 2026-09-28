import { describe, expect, test } from "bun:test";
import { isPathWithin } from "./path-within";
import { fromLongPath } from "./win-path";

describe("isPathWithin", () => {
  const win32: [string, string, boolean][] = [
    ["C:\\ws", "C:\\ws", true],
    ["C:\\ws\\src\\a.ts", "C:\\ws", true],
    ["c:\\WS\\Src\\a.ts", "C:\\ws", true],
    ["C:/ws/src/a.ts", "C:\\ws", true],
    ["C:\\ws/src\\a.ts", "C:\\ws\\", true],
    ["\\\\?\\C:\\ws\\src\\a.ts", "C:\\ws", true],
    ["C:\\ws\\src\\a.ts", "\\\\?\\C:\\ws", true],
    ["C:\\ws\\..foo\\a.ts", "C:\\ws", true],
    ["C:\\ws-other\\a.ts", "C:\\ws", false],
    ["C:\\ws\\..\\secret.txt", "C:\\ws", false],
    ["C:\\", "C:\\ws", false],
    ["D:\\ws\\a.ts", "C:\\ws", false],
    ["\\\\server\\share\\ws\\a.ts", "C:\\ws", false],
    ["\\\\?\\UNC\\server\\share\\a.ts", "\\\\server\\share", true],
  ];
  for (const [child, root, expected] of win32) {
    test(`win32: ${child} in ${root} -> ${expected}`, () => {
      expect(isPathWithin(child, root, "win32")).toBe(expected);
    });
  }

  const posix: [string, string, boolean][] = [
    ["/ws", "/ws", true],
    ["/ws/src/a.ts", "/ws/", true],
    ["/ws/..foo", "/ws", true],
    ["/WS/src/a.ts", "/ws", false],
    ["/ws-other/a.ts", "/ws", false],
    ["/ws/../etc/passwd", "/ws", false],
  ];
  for (const [child, root, expected] of posix) {
    test(`linux: ${child} in ${root} -> ${expected}`, () => {
      expect(isPathWithin(child, root, "linux")).toBe(expected);
    });
  }
});

describe("fromLongPath", () => {
  test("strips the local and UNC extended-length markers on win32", () => {
    expect(fromLongPath("\\\\?\\C:\\ws\\a.ts", "win32")).toBe("C:\\ws\\a.ts");
    expect(fromLongPath("\\\\?\\UNC\\server\\share\\a.ts", "win32")).toBe("\\\\server\\share\\a.ts");
  });

  test("leaves unmarked paths and other platforms alone", () => {
    expect(fromLongPath("C:\\ws\\a.ts", "win32")).toBe("C:\\ws\\a.ts");
    expect(fromLongPath("\\\\.\\PhysicalDrive0", "win32")).toBe("\\\\.\\PhysicalDrive0");
    expect(fromLongPath("\\\\?\\C:\\ws", "linux")).toBe("\\\\?\\C:\\ws");
  });
});
