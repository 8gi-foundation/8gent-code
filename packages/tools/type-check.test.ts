/**
 * type-check.test.ts
 * Basic smoke tests for the type-check module.
 * Run: bun test packages/tools/type-check.test.ts
 */

import { expect, test, describe } from "bun:test";
import { typeOf, is, assertType, checkType } from "./type-check.ts";

describe("typeOf", () => {
  test("primitives", () => {
    expect(typeOf(null)).toBe("null");
    expect(typeOf(undefined)).toBe("undefined");
    expect(typeOf("hello")).toBe("string");
    expect(typeOf(42)).toBe("number");
    expect(typeOf(true)).toBe("boolean");
  });

  test("NaN is distinct from number", () => {
    expect(typeOf(NaN)).toBe("NaN");
    expect(typeOf(42)).toBe("number");
  });

  test("complex types", () => {
    expect(typeOf([])).toBe("array");
    expect(typeOf({})).toBe("object");
    expect(typeOf(() => {})).toBe("function");
    expect(typeOf(new Date())).toBe("date");
    expect(typeOf(/foo/)).toBe("regex");
    expect(typeOf(Promise.resolve())).toBe("promise");
    expect(typeOf(new Error())).toBe("error");
    expect(typeOf(new Map())).toBe("map");
    expect(typeOf(new Set())).toBe("set");
  });
});

describe("is guards", () => {
  test("is.string", () => {
    expect(is.string("hi")).toBe(true);
    expect(is.string(42)).toBe(false);
  });

  test("is.number", () => {
    expect(is.number(42)).toBe(true);
    expect(is.number(NaN)).toBe(false);
    expect(is.number("42")).toBe(false);
  });

  test("is.array", () => {
    expect(is.array([])).toBe(true);
    expect(is.array({})).toBe(false);
  });

  test("is.null / is.undefined / is.nullish", () => {
    expect(is.null(null)).toBe(true);
    expect(is.null(undefined)).toBe(false);
    expect(is.undefined(undefined)).toBe(true);
    expect(is.nullish(null)).toBe(true);
    expect(is.nullish(undefined)).toBe(true);
    expect(is.nullish(0)).toBe(false);
  });

  test("is.date valid/invalid", () => {
    expect(is.date(new Date())).toBe(true);
    expect(is.date(new Date("invalid"))).toBe(false);
    expect(is.date("2024-01-01")).toBe(false);
  });

  test("is.promise", () => {
    expect(is.promise(Promise.resolve())).toBe(true);
    expect(is.promise({ then: () => {} })).toBe(true);
    expect(is.promise({})).toBe(false);
  });

  test("is.integer / is.finite", () => {
    expect(is.integer(5)).toBe(true);
    expect(is.integer(5.5)).toBe(false);
    expect(is.finite(42)).toBe(true);
    expect(is.finite(Infinity)).toBe(false);
  });
});

describe("assertType", () => {
  test("passes silently on match", () => {
    expect(() => assertType(42, "number")).not.toThrow();
    expect(() => assertType(null, "null")).not.toThrow();
    expect(() => assertType([], "array")).not.toThrow();
  });

  test("throws TypeError on mismatch", () => {
    expect(() => assertType("hi", "number")).toThrow(TypeError);
    expect(() => assertType("hi", "number", "age")).toThrow(/age/);
  });

  test("error message includes actual type", () => {
    try {
      assertType("hi", "number", "count");
    } catch (e) {
      expect((e as TypeError).message).toContain("expected number");
      expect((e as TypeError).message).toContain("got string");
    }
  });
});

describe("checkType", () => {
  test("returns boolean", () => {
    expect(checkType([], "array")).toBe(true);
    expect(checkType([], "object")).toBe(false);
    expect(checkType(null, "null")).toBe(true);
  });
});
