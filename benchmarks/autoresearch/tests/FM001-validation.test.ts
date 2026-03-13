/**
 * FM001 — Input Validation with Structured Errors
 *
 * Loads the LLM-generated validation function from FIXTURE_PATH env var,
 * then verifies correctness.
 */
import { describe, test, expect } from "bun:test";

const fixturePath = process.env.FIXTURE_PATH;
if (!fixturePath) throw new Error("FIXTURE_PATH env var required");

const mod = await import(fixturePath);
const validateInput: Function =
  mod.default ?? mod.validateInput ?? mod.validate;

if (!validateInput || typeof validateInput !== "function") {
  throw new Error(
    "Module must export validateInput, validate, or default function"
  );
}

describe("FM001: Input Validation", () => {
  test("valid input passes", () => {
    const result = validateInput({
      name: "Alice",
      email: "alice@example.com",
      age: 30,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("valid input with password passes", () => {
    const result = validateInput({
      name: "Bob",
      email: "bob@test.io",
      age: 25,
      password: "securePass123",
    });
    expect(result.valid).toBe(true);
  });

  test("rejects empty name", () => {
    const result = validateInput({
      name: "",
      email: "a@b.com",
      age: 20,
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e: any) => e.field === "name" || (typeof e === "string" && e.includes("name"))
      )
    ).toBe(true);
  });

  test("rejects whitespace-only name", () => {
    const result = validateInput({
      name: "   ",
      email: "a@b.com",
      age: 20,
    });
    expect(result.valid).toBe(false);
  });

  test("rejects email without @", () => {
    const result = validateInput({
      name: "Test",
      email: "invalid-email",
      age: 20,
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e: any) => e.field === "email" || (typeof e === "string" && e.includes("email"))
      )
    ).toBe(true);
  });

  test("rejects email without dot", () => {
    const result = validateInput({
      name: "Test",
      email: "user@domain",
      age: 20,
    });
    expect(result.valid).toBe(false);
  });

  test("rejects negative age", () => {
    const result = validateInput({
      name: "Test",
      email: "a@b.com",
      age: -1,
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e: any) => e.field === "age" || (typeof e === "string" && e.includes("age"))
      )
    ).toBe(true);
  });

  test("rejects age over 150", () => {
    const result = validateInput({
      name: "Test",
      email: "a@b.com",
      age: 200,
    });
    expect(result.valid).toBe(false);
  });

  test("rejects short password when provided", () => {
    const result = validateInput({
      name: "Test",
      email: "a@b.com",
      age: 25,
      password: "short",
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e: any) =>
          e.field === "password" ||
          (typeof e === "string" && e.includes("password"))
      )
    ).toBe(true);
  });

  test("accepts missing password (optional)", () => {
    const result = validateInput({
      name: "Test",
      email: "a@b.com",
      age: 25,
    });
    expect(result.valid).toBe(true);
  });

  test("multiple errors returned at once", () => {
    const result = validateInput({
      name: "",
      email: "nope",
      age: -5,
      password: "x",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});
