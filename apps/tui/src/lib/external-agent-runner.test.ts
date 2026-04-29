import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	EXTERNAL_AGENT_PRESETS,
	type ExternalAgentPreset,
	getPreset,
	installAgent,
	isInstalled,
	listPresetIds,
} from "./external-agent-runner.js";

const ORIGINAL_PATH = process.env.PATH ?? "";

describe("external-agent-runner — preset shape", () => {
	test("every preset declares either install or homepage so /spawn never dead-ends", () => {
		for (const id of listPresetIds()) {
			const p = getPreset(id);
			expect(p).not.toBeNull();
			const hasInstall = !!p?.install;
			const hasHomepage = !!p?.homepage;
			expect(hasInstall || hasHomepage).toBeTrue();
		}
	});

	test("each install recipe with fallbacks declares hintBins on every step", () => {
		// Without hintBins we can't search past $PATH after npm/pip lands a
		// binary in a non-rc-sourced dir — defeats the whole point.
		for (const id of listPresetIds()) {
			const p = getPreset(id);
			if (!p?.install?.fallbacks?.length) continue;
			expect(Array.isArray(p.install.hintBins)).toBeTrue();
			for (const fb of p.install.fallbacks) {
				expect(Array.isArray(fb.hintBins)).toBeTrue();
				expect(fb.hintBins?.length ?? 0).toBeGreaterThan(0);
			}
		}
	});

	test("npm-based install commands all carry an `npm` precheck", () => {
		// Skipping the brew strategy on a brew-less machine should be
		// automatic; same for npm. The precheck is the gate.
		for (const id of listPresetIds()) {
			const p = getPreset(id);
			const i = p?.install;
			if (!i) continue;
			if (i.command.startsWith("npm ")) expect(i.precheck).toContain("npm");
			for (const fb of i.fallbacks ?? []) {
				if (fb.command.startsWith("npm ")) expect(fb.precheck).toContain("npm");
				if (fb.command.startsWith("brew ")) expect(fb.precheck).toContain("brew");
			}
		}
	});
});

describe("external-agent-runner — PATH discovery & self-heal", () => {
	let sandbox: string;
	let binDir: string;
	let savedPath: string;

	beforeEach(() => {
		sandbox = mkdtempSync(join(tmpdir(), "8gent-runner-"));
		binDir = join(sandbox, "bin");
		mkdirSync(binDir, { recursive: true });
		savedPath = process.env.PATH ?? "";
	});

	afterEach(() => {
		process.env.PATH = savedPath;
		try {
			rmSync(sandbox, { recursive: true, force: true });
		} catch {}
	});

	test("isInstalled returns true and patches PATH when binary exists in a hint dir", () => {
		const binaryName = `fake-agent-${Date.now()}`;
		const binPath = join(binDir, binaryName);
		writeFileSync(binPath, "#!/bin/sh\necho ok\n");
		chmodSync(binPath, 0o755);

		const sep = process.platform === "win32" ? ";" : ":";
		// Strip our sandbox dir from PATH so the only way isInstalled can
		// succeed is via hintBins discovery + self-heal.
		process.env.PATH = (process.env.PATH ?? "")
			.split(sep)
			.filter((d) => d !== binDir)
			.join(sep);
		expect(process.env.PATH?.split(sep)).not.toContain(binDir);

		const preset: ExternalAgentPreset = {
			id: "fake",
			label: "Fake",
			command: binaryName,
			promptMode: "arg",
			args: [],
			install: {
				command: "true",
				hintBins: [binDir],
			},
		};

		const ok = isInstalled(preset);
		expect(ok).toBeTrue();
		// Self-heal: dir prepended so a follow-up spawn() finds the binary
		// without the user editing their shell rc.
		expect(process.env.PATH?.split(sep)[0]).toBe(binDir);
	});

	test("isInstalled returns false when binary is nowhere on disk", () => {
		const preset: ExternalAgentPreset = {
			id: "ghost",
			label: "Ghost",
			command: `definitely-does-not-exist-${Date.now()}`,
			promptMode: "arg",
			args: [],
		};
		expect(isInstalled(preset)).toBeFalse();
	});
});

describe("external-agent-runner — multi-strategy install", () => {
	let sandbox: string;
	let binDir: string;
	let savedPath: string;

	beforeEach(() => {
		sandbox = mkdtempSync(join(tmpdir(), "8gent-install-"));
		binDir = join(sandbox, "bin");
		mkdirSync(binDir, { recursive: true });
		savedPath = process.env.PATH ?? "";
	});

	afterEach(() => {
		process.env.PATH = savedPath;
		try {
			rmSync(sandbox, { recursive: true, force: true });
		} catch {}
	});

	test("falls through failing primary to a working fallback", async () => {
		const binaryName = `staged-agent-${Date.now()}`;
		const stagePath = join(sandbox, "stage", binaryName);
		mkdirSync(join(sandbox, "stage"), { recursive: true });
		writeFileSync(stagePath, "#!/bin/sh\necho ok\n");
		chmodSync(stagePath, 0o755);

		const finalBin = join(binDir, binaryName);
		const preset: ExternalAgentPreset = {
			id: "staged",
			label: "Staged",
			command: binaryName,
			promptMode: "arg",
			args: [],
			install: {
				// Primary fails: command exits non-zero, leaves nothing.
				command: "false",
				hintBins: [binDir],
				fallbacks: [
					{
						name: "copy-from-stage",
						// Fallback succeeds: copies the prepared binary into binDir.
						command: `cp "${stagePath}" "${finalBin}" && chmod +x "${finalBin}"`,
						hintBins: [binDir],
					},
				],
			},
		};

		const lines: string[] = [];
		const result = await installAgent(preset, (line, source) => {
			if (source === "info") lines.push(line);
		});

		expect(result.ok).toBeTrue();
		expect(result.strategyUsed).toBe("copy-from-stage");
		expect(result.resolvedPath).toBe(finalBin);
		// PATH self-heal: dir is prepended.
		const sep = process.platform === "win32" ? ";" : ":";
		expect(process.env.PATH?.split(sep)[0]).toBe(binDir);
		// Logs include both attempts.
		const joined = lines.join("\n");
		expect(joined).toContain("primary");
		expect(joined).toContain("copy-from-stage");
	});

	test("skips strategies whose precheck fails", async () => {
		const binaryName = `precheck-agent-${Date.now()}`;
		const finalBin = join(binDir, binaryName);
		const preset: ExternalAgentPreset = {
			id: "precheck",
			label: "Precheck",
			command: binaryName,
			promptMode: "arg",
			args: [],
			install: {
				command: "echo would-have-installed",
				// Precheck fails => primary skipped entirely.
				precheck: "false",
				hintBins: [binDir],
				fallbacks: [
					{
						name: "drop-binary",
						command: `printf '#!/bin/sh\\necho ok\\n' > "${finalBin}" && chmod +x "${finalBin}"`,
						hintBins: [binDir],
					},
				],
			},
		};

		const lines: string[] = [];
		const result = await installAgent(preset, (line, source) => {
			if (source === "info") lines.push(line);
		});

		expect(result.ok).toBeTrue();
		expect(result.strategyUsed).toBe("drop-binary");
		expect(lines.join("\n")).toContain("precheck failed");
	});

	test("returns actionable diagnostic when binary is on disk but not on PATH", async () => {
		// Edge case: install command "succeeds" but drops the binary in a
		// dir nobody knows about — diagnostic must name where the binary
		// actually lives so the user can fix PATH.
		const binaryName = `orphan-${Date.now()}`;
		const orphanDir = join(sandbox, "orphan");
		mkdirSync(orphanDir, { recursive: true });
		const orphanPath = join(orphanDir, binaryName);
		writeFileSync(orphanPath, "#!/bin/sh\necho ok\n");
		chmodSync(orphanPath, 0o755);

		const preset: ExternalAgentPreset = {
			id: "orphan",
			label: "Orphan",
			command: binaryName,
			promptMode: "arg",
			args: [],
			install: {
				// Strategy "succeeds" but its hintBins are wrong — points at an
				// empty dir. Discovery falls back to common dirs, finds nothing.
				command: "true",
				hintBins: [join(sandbox, "wrong")],
			},
		};

		const result = await installAgent(preset);
		expect(result.ok).toBeFalse();
		// Sanity: error mentions the binary name so the message is useful.
		expect(result.error ?? "").toContain(binaryName);
	});
});

describe("external-agent-runner — preset coverage parity", () => {
	test("listPresetIds matches EXTERNAL_AGENT_PRESETS keys", () => {
		const ids = listPresetIds().sort();
		const keys = Object.keys(EXTERNAL_AGENT_PRESETS).sort();
		expect(ids).toEqual(keys);
	});

	test("getPreset is case-insensitive", () => {
		expect(getPreset("CLAUDE")?.id).toBe("claude");
		expect(getPreset("Claude")?.id).toBe("claude");
	});
});

// Restore PATH after the suite even if a test threw before the afterEach.
process.on("exit", () => {
	process.env.PATH = ORIGINAL_PATH;
});
