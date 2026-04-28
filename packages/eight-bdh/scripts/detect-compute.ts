#!/usr/bin/env bun
/**
 * Auto-detect local compute and print per-phase recommendation table.
 * Spec: docs/specs/8GENT-0.1-BDH-ORCHESTRATOR.md §3.5.
 */

interface DetectedHardware {
	platform: "darwin" | "linux" | "other";
	chip: string;
	cpuCores?: string;
	gpu: string;
	gpuCores?: string;
	memoryGB?: string;
	os: string;
}

function runSync(
	cmd: string,
	args: string[],
): { stdout: string; ok: boolean } {
	try {
		const proc = Bun.spawnSync({
			cmd: [cmd, ...args],
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = new TextDecoder().decode(proc.stdout ?? new Uint8Array());
		return { stdout, ok: proc.exitCode === 0 };
	} catch {
		return { stdout: "", ok: false };
	}
}

function detectMacOS(): DetectedHardware {
	const hw = runSync("system_profiler", ["SPHardwareDataType"]);
	const display = runSync("system_profiler", ["SPDisplaysDataType"]);
	const sw = runSync("sw_vers", ["-productVersion"]);

	const chipMatch = hw.stdout.match(/Chip:\s*(.+)/);
	const memMatch = hw.stdout.match(/Memory:\s*(.+)/);
	const cpuMatch = hw.stdout.match(/Total Number of Cores:\s*(.+)/);
	const gpuChipsetMatch = display.stdout.match(/Chipset Model:\s*(.+)/);
	const gpuCoresMatch = display.stdout.match(/Total Number of Cores:\s*(\d+)/);

	return {
		platform: "darwin",
		chip: chipMatch?.[1]?.trim() ?? "Unknown Apple Silicon",
		cpuCores: cpuMatch?.[1]?.trim(),
		gpu: gpuChipsetMatch?.[1]?.trim() ?? "Apple GPU",
		gpuCores: gpuCoresMatch?.[1]?.trim(),
		memoryGB: memMatch?.[1]?.trim(),
		os: `macOS ${sw.stdout.trim() || "unknown"}`,
	};
}

function detectLinux(): DetectedHardware {
	const nv = runSync("nvidia-smi", [
		"--query-gpu=name,memory.total",
		"--format=csv,noheader",
	]);
	const uname = runSync("uname", ["-r"]);
	const meminfo = runSync("sh", ["-c", "grep MemTotal /proc/meminfo || true"]);

	let gpu = "no GPU detected";
	if (nv.ok && nv.stdout.trim()) {
		gpu = nv.stdout.trim().split("\n")[0] ?? gpu;
	}

	const memMatch = meminfo.stdout.match(/MemTotal:\s*(\d+)\s*kB/);
	const memoryGB = memMatch?.[1]
		? `${(Number.parseInt(memMatch[1], 10) / 1024 / 1024).toFixed(0)} GB`
		: undefined;

	return {
		platform: "linux",
		chip: "x86_64 / arm64 (Linux)",
		gpu,
		memoryGB,
		os: `Linux ${uname.stdout.trim()}`,
	};
}

function detect(): DetectedHardware {
	const platform = process.platform;
	if (platform === "darwin") return detectMacOS();
	if (platform === "linux") return detectLinux();
	return {
		platform: "other",
		chip: "unknown",
		gpu: "unknown",
		os: platform,
	};
}

function recommend(hw: DetectedHardware): string[] {
	const isAppleSilicon =
		hw.platform === "darwin" && /Apple\s+M\d/i.test(hw.chip);
	const hasNvidia =
		hw.platform === "linux" && hw.gpu && !/no GPU/i.test(hw.gpu);

	if (isAppleSilicon) {
		return [
			"  Phase 0 hello-world (5M):  LOCAL  (~1-2h, free)",
			"  Phase 1 single run (10M):  LOCAL  (~overnight, free)",
			"  Phase 1 seed sweep:        RUNPOD (~6h on A100) or LOCAL (~3-5d)",
			"  Phase 2 scale-up (100M):   RUNPOD (~6h on A100)",
		];
	}
	if (hasNvidia) {
		return [
			"  Phase 0 hello-world (5M):  LOCAL  (~10 min on A100-class, free if owned)",
			"  Phase 1 single run (10M):  LOCAL  (~45 min on A100-class)",
			"  Phase 1 seed sweep:        LOCAL  (~6h on A100)",
			"  Phase 2 scale-up (100M):   LOCAL  (~6h on A100)",
		];
	}
	return [
		"  Phase 0 hello-world (5M):  RUNPOD (CPU-only host detected; local would take 6-10h)",
		"  Phase 1 single run (10M):  RUNPOD",
		"  Phase 1 seed sweep:        RUNPOD",
		"  Phase 2 scale-up (100M):   RUNPOD",
	];
}

export async function main(): Promise<void> {
	const hw = detect();
	const summary = [
		`Local: ${hw.chip}`,
		hw.gpuCores ? `${hw.gpuCores} GPU cores` : hw.gpu,
		hw.memoryGB ? hw.memoryGB : null,
		hw.os,
	]
		.filter(Boolean)
		.join(", ");

	console.log(summary);
	console.log("Recommended:");
	for (const line of recommend(hw)) console.log(line);
}

if (import.meta.main) {
	main().catch((err: Error) => {
		console.error(err.message);
		process.exit(1);
	});
}
