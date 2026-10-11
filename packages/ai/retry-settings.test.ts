import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getRetryConfig } from "./providers";

let home: string;
let prev: string | undefined;
beforeEach(() => {
	home = mkdtempSync(path.join(tmpdir(), "retry-"));
	prev = process.env.EIGHT_HOME;
	process.env.EIGHT_HOME = home;
	mkdirSync(path.join(home, ".8gent"), { recursive: true });
});
afterEach(() => {
	if (prev === undefined) process.env.EIGHT_HOME = undefined as never;
	else process.env.EIGHT_HOME = prev;
	rmSync(home, { recursive: true, force: true });
});

const cfg = (model: string) => ({ name: "openrouter", model }) as never;

test("defaults are 3, and 8 for free models", () => {
	expect(getRetryConfig(cfg("a/b"))).toEqual({ maxRetries: 3 });
	expect(getRetryConfig(cfg("a/b:free"))).toEqual({ maxRetries: 8 });
});

test("settings.retry overrides both counts", () => {
	writeFileSync(path.join(home, ".8gent", "settings.json"), JSON.stringify({ retry: { maxRetries: 1, freeModelMaxRetries: 2 } }));
	expect(getRetryConfig(cfg("a/b"))).toEqual({ maxRetries: 1 });
	expect(getRetryConfig(cfg("a/b:free"))).toEqual({ maxRetries: 2 });
});

test("a nonsense value falls back to the default", () => {
	writeFileSync(path.join(home, ".8gent", "settings.json"), JSON.stringify({ retry: { maxRetries: -4, freeModelMaxRetries: "x" } }));
	expect(getRetryConfig(cfg("a/b"))).toEqual({ maxRetries: 3 });
	expect(getRetryConfig(cfg("a/b:free"))).toEqual({ maxRetries: 8 });
});
