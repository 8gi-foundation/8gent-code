import { describe, it, expect, beforeEach } from "bun:test";
import * as path from "path";

const WORK_DIR = process.env.WORK_DIR || path.dirname(process.env.FIXTURE_PATH || ".");

let pipeline: any, schema: any, transforms: any;

beforeEach(async () => {
  try {
    pipeline = await import(path.join(WORK_DIR, "pipeline.ts"));
    schema = await import(path.join(WORK_DIR, "schema.ts"));
    transforms = await import(path.join(WORK_DIR, "transforms.ts"));
  } catch {}
});

describe("Pipeline", () => {
  it("basic map and collect", async () => {
    const P = pipeline.Pipeline || pipeline.default;
    const result = await P.from([1, 2, 3]).map((x: number) => x * 2).collect();
    expect(result).toEqual([2, 4, 6]);
  });

  it("filter works", async () => {
    const P = pipeline.Pipeline || pipeline.default;
    const result = await P.from([1, 2, 3, 4, 5]).filter((x: number) => x % 2 === 0).collect();
    expect(result).toEqual([2, 4]);
  });

  it("map + filter chain", async () => {
    const P = pipeline.Pipeline || pipeline.default;
    const result = await P.from([1, 2, 3, 4])
      .map((x: number) => x * 10)
      .filter((x: number) => x > 20)
      .collect();
    expect(result).toEqual([30, 40]);
  });

  it("flatMap works", async () => {
    const P = pipeline.Pipeline || pipeline.default;
    const result = await P.from([1, 2, 3])
      .flatMap((x: number) => [x, x * 10])
      .collect();
    expect(result).toEqual([1, 10, 2, 20, 3, 30]);
  });

  it("batch groups items", async () => {
    const P = pipeline.Pipeline || pipeline.default;
    const result = await P.from([1, 2, 3, 4, 5]).batch(2).collect();
    expect(result).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("take limits output", async () => {
    const P = pipeline.Pipeline || pipeline.default;
    const result = await P.from([1, 2, 3, 4, 5]).take(3).collect();
    expect(result).toEqual([1, 2, 3]);
  });

  it("skip skips items", async () => {
    const P = pipeline.Pipeline || pipeline.default;
    const result = await P.from([1, 2, 3, 4, 5]).skip(2).collect();
    expect(result).toEqual([3, 4, 5]);
  });

  it("reduce works", async () => {
    const P = pipeline.Pipeline || pipeline.default;
    const sum = await P.from([1, 2, 3, 4]).reduce((acc: number, x: number) => acc + x, 0);
    expect(sum).toBe(10);
  });

  it("count works", async () => {
    const P = pipeline.Pipeline || pipeline.default;
    const n = await P.from([1, 2, 3]).count();
    expect(n).toBe(3);
  });

  it("tap doesn't modify data", async () => {
    const P = pipeline.Pipeline || pipeline.default;
    const sideEffects: number[] = [];
    const result = await P.from([1, 2, 3])
      .tap((x: number) => sideEffects.push(x))
      .map((x: number) => x * 2)
      .collect();
    expect(result).toEqual([2, 4, 6]);
    expect(sideEffects).toEqual([1, 2, 3]);
  });

  it("handles async map", async () => {
    const P = pipeline.Pipeline || pipeline.default;
    const result = await P.from([1, 2, 3])
      .map(async (x: number) => x + 100)
      .collect();
    expect(result).toEqual([101, 102, 103]);
  });
});

describe("Schema Validation", () => {
  it("validates strings", () => {
    const S = schema.S || schema.default;
    const s = S.string().min(3).max(10);
    expect(s.validate("hello").valid).toBe(true);
    expect(s.validate("hi").valid).toBe(false);
    expect(s.validate(42).valid).toBe(false);
  });

  it("validates numbers", () => {
    const S = schema.S || schema.default;
    const n = S.number().min(0).max(100).integer();
    expect(n.validate(42).valid).toBe(true);
    expect(n.validate(3.14).valid).toBe(false); // not integer
    expect(n.validate(-1).valid).toBe(false);
    expect(n.validate("hello").valid).toBe(false);
  });

  it("validates objects", () => {
    const S = schema.S || schema.default;
    const userSchema = S.object({
      name: S.string().min(1),
      age: S.number().positive(),
    });
    expect(userSchema.validate({ name: "Alice", age: 30 }).valid).toBe(true);
    expect(userSchema.validate({ name: "", age: 30 }).valid).toBe(false);
    expect(userSchema.validate({ name: "Alice" }).valid).toBe(false);
  });

  it("validates arrays", () => {
    const S = schema.S || schema.default;
    const arr = S.array(S.number().positive());
    expect(arr.validate([1, 2, 3]).valid).toBe(true);
    expect(arr.validate([1, -2, 3]).valid).toBe(false);
    expect(arr.validate("not array").valid).toBe(false);
  });

  it("returns error paths", () => {
    const S = schema.S || schema.default;
    const userSchema = S.object({
      name: S.string().min(1),
      age: S.number(),
    });
    const result = userSchema.validate({ name: "", age: "not a number" });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Transforms", () => {
  it("deduplicate removes duplicates", () => {
    const fn = transforms.deduplicate || transforms.default?.deduplicate;
    expect(fn([1, 2, 2, 3, 3, 3])).toEqual([1, 2, 3]);
  });

  it("deduplicate with key function", () => {
    const fn = transforms.deduplicate || transforms.default?.deduplicate;
    const items = [{ id: 1, name: "a" }, { id: 2, name: "b" }, { id: 1, name: "c" }];
    const result = fn(items, (x: any) => x.id);
    expect(result.length).toBe(2);
  });

  it("groupBy groups correctly", () => {
    const fn = transforms.groupBy || transforms.default?.groupBy;
    const items = [{ type: "a", v: 1 }, { type: "b", v: 2 }, { type: "a", v: 3 }];
    const groups = fn(items, (x: any) => x.type);
    expect(groups["a"].length).toBe(2);
    expect(groups["b"].length).toBe(1);
  });

  it("sortBy sorts ascending", () => {
    const fn = transforms.sortBy || transforms.default?.sortBy;
    const result = fn([{ v: 3 }, { v: 1 }, { v: 2 }], (x: any) => x.v);
    expect(result.map((x: any) => x.v)).toEqual([1, 2, 3]);
  });

  it("sortBy descending", () => {
    const fn = transforms.sortBy || transforms.default?.sortBy;
    const result = fn([{ v: 3 }, { v: 1 }, { v: 2 }], (x: any) => x.v, "desc");
    expect(result.map((x: any) => x.v)).toEqual([3, 2, 1]);
  });

  it("flatten works", () => {
    const fn = transforms.flatten || transforms.default?.flatten;
    expect(fn([1, [2, 3], 4, [5]])).toEqual([1, 2, 3, 4, 5]);
  });

  it("chunk works", () => {
    const fn = transforms.chunk || transforms.default?.chunk;
    expect(fn([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("zip combines arrays", () => {
    const fn = transforms.zip || transforms.default?.zip;
    expect(fn([1, 2, 3], ["a", "b", "c"])).toEqual([[1, "a"], [2, "b"], [3, "c"]]);
  });

  it("does not mutate input", () => {
    const fn = transforms.sortBy || transforms.default?.sortBy;
    const input = [{ v: 3 }, { v: 1 }];
    const copy = [...input];
    fn(input, (x: any) => x.v);
    expect(input[0].v).toBe(copy[0].v);
  });
});
