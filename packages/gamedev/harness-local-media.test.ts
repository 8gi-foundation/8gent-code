/**
 * The local model tier in the media harness (#3422). With EIGHT_LOCAL_MEDIA
 * unset (or anything but "1") the harness must behave exactly as before: no
 * local server is asked anything. With it set to "1" an image model found on
 * a loopback fake is used before the cloud path.
 *
 * Each case runs the harness in a child bun process with HOME and TMPDIR in a
 * temp folder. The harness resolves its asset folder with os.homedir() at
 * import, and Bun freezes homedir() at process start, so the test preload's
 * temp HOME does not reach it in-process; a child started with HOME set does.
 * The child also gets a fresh detectTools() cache per case.
 *
 * OPENAI_API_KEY is set in every child and fetch to api.openai.com is answered
 * there with a 500, so each case sees both its local and its cloud requests.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 1x1 transparent PNG.
const PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const HARNESS = join(import.meta.dir, "harness.ts");

let root = "";
let hits: { path: string; body: string }[] = [];
let withImage: ReturnType<typeof Bun.serve>;
let chatOnly: ReturnType<typeof Bun.serve>;
let CLOSED = "";
let caseNo = 0;

function fakeServer(models: unknown[]): ReturnType<typeof Bun.serve> {
	return Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const path = new URL(req.url).pathname;
			hits.push({ path, body: req.method === "POST" ? await req.text() : "" });
			if (path === "/v1/models") return Response.json({ object: "list", data: models });
			if (path === "/v1/images/generations")
				return Response.json({ created: 0, data: [{ b64_json: PNG_B64 }] });
			return new Response("not found", { status: 404 });
		},
	});
}

const CHILD = `
const cloud = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
	const url = String(input instanceof Request ? input.url : input);
	if (url.startsWith("https://api.openai.com/")) { cloud.push(url); return new Response("nope", { status: 500 }); }
	return realFetch(input, init);
};
console.log = () => {};
const { generate, listAssets } = await import(process.env.HARNESS_PATH);
const result = await generate(JSON.parse(process.env.GEN_OPTS));
process.stdout.write("\\n@@" + JSON.stringify({ result, cloud, assets: listAssets("sprite") }));
`;

type ChildOut = {
	result: Record<string, unknown>;
	cloud: string[];
	assets: Record<string, unknown>[];
	home: string;
};

async function runHarness(
	env: Record<string, string | undefined>,
	opts: Record<string, unknown> = {},
): Promise<ChildOut> {
	hits = [];
	const dir = join(root, `case-${caseNo++}`);
	const home = join(dir, "home");
	mkdirSync(home, { recursive: true });
	mkdirSync(join(dir, "tmp"), { recursive: true });
	const childEnv: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: home,
		TMPDIR: join(dir, "tmp"),
		HARNESS_PATH: HARNESS,
		GEN_OPTS: JSON.stringify({ prompt: "a walking robot", ...opts }),
		OPENAI_API_KEY: "sk-test-not-real",
		// Every local endpoint the probe could ask is a fake or a closed port, never a real server.
		MLX_SERVE_URL: `http://127.0.0.1:${withImage.port}`,
		LM_STUDIO_HOST: `http://127.0.0.1:${chatOnly.port}`,
		OLLAMA_BASE_URL: CLOSED,
	};
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) delete childEnv[k];
		else childEnv[k] = v;
	}
	const proc = Bun.spawn([process.execPath, "-e", CHILD], {
		env: childEnv,
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`child exited ${code}: ${err}`);
	const at = out.lastIndexOf("@@");
	return { ...(JSON.parse(out.slice(at + 2)) as Omit<ChildOut, "home">), home };
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "harness-local-media-"));
	withImage = fakeServer([
		{ id: "mlx-community/Qwen3-8B-4bit", capabilities: ["chat"], state: "ready" },
		{ id: "black-forest-labs/FLUX.1-schnell", capabilities: ["image"], state: "ready" },
	]);
	chatOnly = fakeServer([{ id: "qwen3:14b", object: "model", owned_by: "library" }]);
	const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
	CLOSED = `http://127.0.0.1:${closed.port}`;
	closed.stop(true);
});

afterAll(() => {
	withImage.stop(true);
	chatOnly.stop(true);
	rmSync(root, { recursive: true, force: true });
	expect(existsSync(root)).toBe(false);
});

const CLOUD_FAIL = { success: false, reason: "Cloud API error 500: nope", path: "cloud" };
const CLOUD_URLS = ["https://api.openai.com/v1/images/generations"];

describe("flag off: no behaviour change", () => {
	for (const flag of [undefined, "", "0", "true", "yes", " 1"]) {
		test(`EIGHT_LOCAL_MEDIA=${JSON.stringify(flag)}: straight to the cloud, no local server asked`, async () => {
			const r = await runHarness({ EIGHT_LOCAL_MEDIA: flag });
			expect(r.result).toEqual(CLOUD_FAIL);
			expect(r.cloud).toEqual(CLOUD_URLS);
			expect(hits).toEqual([]);
		});
	}
});

describe("flag on", () => {
	test("uses the local image model the probe found, and never reaches the cloud", async () => {
		const r = await runHarness({ EIGHT_LOCAL_MEDIA: "1" });
		expect(r.result.success).toBe(true);
		expect(r.result.path).toBe("local");
		const sheet = r.result.sheetPath as string;
		expect(sheet.startsWith(join(r.home, ".8gent", "assets", "media", "local-"))).toBe(true);
		expect(readFileSync(sheet).equals(Buffer.from(PNG_B64, "base64"))).toBe(true);
		expect(r.cloud).toEqual([]);

		const post = hits.find((h) => h.path === "/v1/images/generations");
		expect(JSON.parse(post?.body ?? "{}")).toMatchObject({
			model: "black-forest-labs/FLUX.1-schnell",
			size: "1024x1024",
		});
		expect(r.assets[0]).toMatchObject({
			path: "local",
			tags: ["local-model:black-forest-labs/FLUX.1-schnell"],
		});
	});

	test("no image-capable local model: says so and falls through to the cloud unchanged", async () => {
		const r = await runHarness({ EIGHT_LOCAL_MEDIA: "1", MLX_SERVE_URL: CLOSED });
		expect(r.result).toEqual(CLOUD_FAIL);
		expect(hits.map((h) => h.path)).toEqual(["/v1/models"]);
		expect(r.cloud).toEqual(CLOUD_URLS);
	});

	test("a non-loopback MLX_SERVE_URL is refused, never contacted", async () => {
		// TEST-NET-1: unroutable, so a request would hang until the probe timeout.
		const t = performance.now();
		const r = await runHarness({ EIGHT_LOCAL_MEDIA: "1", MLX_SERVE_URL: "http://192.0.2.1:11234" });
		expect(performance.now() - t).toBeLessThan(1400);
		expect(r.result).toEqual(CLOUD_FAIL);
		expect(hits.map((h) => h.path)).toEqual(["/v1/models"]);
	});

	test("forceCloud skips the probe", async () => {
		const r = await runHarness({ EIGHT_LOCAL_MEDIA: "1" }, { forceCloud: true });
		expect(r.result).toEqual(CLOUD_FAIL);
		expect(hits).toEqual([]);
	});
});
