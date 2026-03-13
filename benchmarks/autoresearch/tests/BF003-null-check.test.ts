/**
 * BF003 — Null Reference in Data Pipeline
 *
 * Loads the LLM-generated fix from FIXTURE_PATH env var,
 * then verifies null-safety.
 */
import { describe, test, expect } from "bun:test";

const fixturePath = process.env.FIXTURE_PATH;
if (!fixturePath) throw new Error("FIXTURE_PATH env var required");

const mod = await import(fixturePath);
const processRecord: Function =
  mod.default ?? mod.processRecord ?? mod.process;

if (!processRecord || typeof processRecord !== "function") {
  throw new Error(
    "Module must export processRecord, process, or default function"
  );
}

describe("BF003: Null Check Fix", () => {
  test("null input returns invalid with error", () => {
    const result = processRecord(null as any);
    expect(result.valid).toBe(false);
    expect(result.normalized).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("undefined input returns invalid with error", () => {
    const result = processRecord(undefined as any);
    expect(result.valid).toBe(false);
    expect(result.normalized).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("valid record normalizes correctly", () => {
    const result = processRecord({
      id: "  ABC123  ",
      name: "  Jane Doe  ",
      email: "  JANE@Example.COM  ",
      metadata: { role: "admin" },
    });
    expect(result.valid).toBe(true);
    expect(result.normalized).not.toBeNull();
    expect(result.normalized!.id).toBe("abc123");
    expect(result.normalized!.name).toBe("Jane Doe");
    expect(result.normalized!.email).toBe("jane@example.com");
  });

  test("missing optional email doesn't throw", () => {
    const result = processRecord({
      id: "x1",
      name: "Test",
    });
    expect(result.valid).toBe(true);
    expect(result.normalized).not.toBeNull();
  });

  test("missing optional metadata doesn't throw", () => {
    const result = processRecord({
      id: "x2",
      name: "Test",
      email: "test@example.com",
    });
    expect(result.valid).toBe(true);
    expect(result.normalized!.metadata).toBeDefined();
  });

  test("invalid email format is caught", () => {
    const result = processRecord({
      id: "x3",
      name: "Test",
      email: "not-an-email",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: any) =>
      typeof e === "string"
        ? e.toLowerCase().includes("email")
        : e?.message?.toLowerCase().includes("email") ?? e?.field === "email"
    )).toBe(true);
  });

  test("empty id is caught", () => {
    const result = processRecord({
      id: "   ",
      name: "Test",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("empty name is caught", () => {
    const result = processRecord({
      id: "ok",
      name: "   ",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
