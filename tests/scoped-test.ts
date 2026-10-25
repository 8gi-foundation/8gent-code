/**
 * `test` that runs each body inside its own read-allow session scope, the way a real turn does.
 * With no scope active a call remembers nothing (#4901), so a test that says yes and then checks
 * a later call needs a scope around both. Use bun's own `test` to test the no-scope case.
 */
import { test as bunTest } from "bun:test";
import { ReadScope, runInReadScope } from "../packages/permissions/read-allow";

type Fn = (...a: never[]) => unknown;
const inScope =
	(fn: Fn): Fn =>
	(...a) =>
		runInReadScope(new ReadScope(), () => fn(...a));

export const test = Object.assign(
	(name: string, fn: Fn, timeout?: number) => bunTest(name, inScope(fn) as never, timeout),
	{
		// biome-ignore lint/suspicious/noExplicitAny: mirrors bun's own overloaded test.each
		each: ((table: any) => (name: string, fn: any) =>
			// biome-ignore lint/suspicious/noExplicitAny: mirrors bun's own overloaded test.each
			(bunTest.each as any)(table)(name, inScope(fn))) as typeof bunTest.each,
	},
);
