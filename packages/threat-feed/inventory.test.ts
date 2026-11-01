import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Fetch } from "./feeds";
import { inventoryRepo, repoList } from "./inventory";

const fx = (n: string) => fs.readFileSync(path.join(import.meta.dir, "fixtures", n), "utf8");

describe("repoList", () => {
	test("prefixes the org and drops archive-proposed unless asked", () => {
		const m = {
			org: "o",
			repos: [
				{ name: "a", status: "active" },
				{ name: "b", status: "archive-proposed" },
			],
		};
		expect(repoList(m)).toEqual(["o/a"]);
		expect(repoList(m, true)).toEqual(["o/a", "o/b"]);
	});
});

describe("inventoryRepo", () => {
	const tree = {
		tree: [
			{ path: "bun.lock", type: "blob", sha: "s1", size: 10 },
			{ path: "web/package-lock.json", type: "blob", sha: "s2", size: 10 },
			{ path: "bun.lockb", type: "blob", sha: "s3", size: 10 },
			{ path: "node_modules/x/package-lock.json", type: "blob", sha: "s4", size: 10 },
			{ path: "src", type: "tree", sha: "s5" },
		],
	};
	const blobs: Record<string, string> = { s1: fx("bun.lock"), s2: "{bad json" };
	const calls: { url: string; auth: unknown; method?: string }[] = [];
	const f: Fetch = async (url, init) => {
		calls.push({
			url,
			auth: (init?.headers as Record<string, string>)?.authorization,
			method: init?.method,
		});
		if (url.includes("/git/trees/")) return new Response(JSON.stringify(tree));
		const sha = url.split("/").pop() as string;
		return blobs[sha] ? new Response(blobs[sha]) : new Response("", { status: 404 });
	};

	test("reads text lockfiles, records binary and malformed ones as skips, ignores node_modules", async () => {
		const inv = await inventoryRepo("o/r", "tok", f);
		expect(inv.deps.map((d) => d.name)).toEqual(["@scope/pkg", "lodash"]);
		expect(inv.lockfiles).toEqual(["bun.lock", "web/package-lock.json", "bun.lockb"]);
		expect(inv.skipped.some((s) => s.startsWith("bun.lockb: binary"))).toBe(true);
		expect(inv.skipped.some((s) => s.startsWith("web/package-lock.json: parse failed"))).toBe(true);
	});
	test("is read-only: GET only, token only in the header", async () => {
		expect(calls.every((c) => !c.method || c.method === "GET")).toBe(true);
		expect(calls.every((c) => !c.url.includes("tok"))).toBe(true);
	});
	test("an unreadable repo is a recorded skip, not a crash", async () => {
		const inv = await inventoryRepo("o/gone", "t", async () => new Response("", { status: 404 }));
		expect(inv.deps).toEqual([]);
		expect(inv.skipped[0]).toContain("HTTP 404");
	});
	test("a repo with no lockfile is listed as a gap", async () => {
		const inv = await inventoryRepo(
			"o/n",
			"t",
			async () => new Response(JSON.stringify({ tree: [] })),
		);
		expect(inv.skipped).toEqual(["no lockfile found"]);
	});
	test("a truncated tree is flagged", async () => {
		const inv = await inventoryRepo(
			"o/big",
			"t",
			async () => new Response(JSON.stringify({ truncated: true, tree: [] })),
		);
		expect(inv.skipped[0]).toContain("truncated");
	});
});
