import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf-8");
const pins = JSON.parse(read("packages/eight/runtime-pins.json")) as {
	llama: { tag: string; url: string; sha256: string; commit: string };
	whisper: { tag: string; url: string; sha256: string };
	targets: string[];
	assets: Record<string, string>;
};
const build = read("scripts/build-runtime.sh");
const verify = read("scripts/verify-runtime.sh");
const wf = read(".github/workflows/runtime-binaries.yml");
const rel = read(".github/workflows/release-binaries.yml");

describe("runtime pins (#4906)", () => {
	test("each source is a tag tarball with a full sha256", () => {
		for (const s of [pins.llama, pins.whisper]) {
			expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(s.url).toBe(
				s === pins.llama
					? `https://github.com/ggml-org/llama.cpp/archive/refs/tags/${s.tag}.tar.gz`
					: `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${s.tag}.tar.gz`,
			);
		}
		expect(pins.llama.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(pins.whisper.tag).toBe("v1.9.5");
	});

	test("every target is built, verified and collected", () => {
		expect(pins.targets).toEqual([
			"android-arm64",
			"linux-x64",
			"linux-arm64",
			"darwin-arm64",
			"darwin-x64",
		]);
		for (const t of pins.targets) {
			expect(build).toContain(`${t})`);
			expect(verify).toContain(t);
			expect(wf).toContain(t);
		}
	});

	test("asset names are llama-server-<target> and whisper-cli-<target>", () => {
		expect(pins.assets).toEqual({
			"llama-server": "llama-server-{target}",
			"whisper-cli": "whisper-cli-{target}",
		});
		expect(build).toContain('"llama-server-$target"');
		expect(build).toContain('"whisper-cli-$target"');
	});

	test("the build checks the pinned sha256 before unpacking, and compiles in no network feature", () => {
		expect(build.indexOf("sha256_check")).toBeLessThan(build.indexOf("tar -xzf"));
		expect(build).toContain("LLAMA_OPENSSL=OFF");
		expect(build).toContain("LLAMA_USE_PREBUILT_UI=OFF");
		expect(build).toContain("WHISPER_CURL=OFF");
	});

	test("the android build is run in Termux's own userland by digest-pinned image", () => {
		expect(wf).toContain("smoke-android");
		expect(wf).toMatch(/termux\/termux-docker@sha256:[0-9a-f]{64}/);
		expect(wf).toContain("ubuntu-24.04-arm");
	});

	test("the release attaches the assets with their sums, and the build is not a release gate", () => {
		expect(rel).toContain("uses: ./.github/workflows/runtime-binaries.yml");
		expect(rel).toContain("runtime/runtime.sha256");
		expect(rel).toContain('>> "$RUNNER_TEMP/installers.sha256"');
		expect(rel).not.toMatch(/needs\.runtime-binaries\.result == 'success' \}\}/);
	});
});
