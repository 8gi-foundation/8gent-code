/**
 * pipeline-cli.ts - CLI entry for the adaptive three-model pipeline.
 *
 * Backs `8gent pipeline "<task>"`. Runs the AdaptivePipeline, streams
 * progress, and writes the artifact to disk.
 *
 *   8gent pipeline "Build an animated 3D portfolio hero as index.html"
 *   8gent pipeline --out ./site "<task>"
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AdaptivePipeline } from "./adaptive-pipeline.js";

export async function runPipelineCommand(args: string[]): Promise<number> {
	let outDir = resolve(process.cwd(), "pipeline-output");
	const taskParts: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--out" && args[i + 1]) {
			outDir = resolve(args[++i]);
		} else if (!args[i].startsWith("-")) {
			taskParts.push(args[i]);
		}
	}
	const task = taskParts.join(" ").trim();

	if (!task) {
		console.error('Usage: 8gent pipeline [--out <dir>] "<build task>"');
		console.error("Runs the adaptive three-model pipeline (orchestrator + context + engineer + repair).");
		return 1;
	}

	console.log("8gent adaptive pipeline");
	console.log(`task: ${task}`);
	console.log("");

	const pipeline = await AdaptivePipeline.create({
		task,
		onProgress: (m) => console.log(`  ${m}`),
	});
	const result = await pipeline.run(task);

	mkdirSync(outDir, { recursive: true });
	const artifactPath = join(outDir, "index.html");
	writeFileSync(artifactPath, result.artifact || "<!-- pipeline produced no artifact -->");

	console.log("");
	console.log(`stages : ${result.stages.length}`);
	for (const s of result.stages) {
		console.log(
			`  ${s.stage.padEnd(14)} ${s.provider}/${s.model}  attempts=${s.attempts}  ${s.ok ? "ok" : "FAILED"}`,
		);
	}
	console.log(`time   : ${(result.totalMs / 1000).toFixed(1)}s`);
	console.log(`defects: ${result.defects.length}`);
	for (const d of result.defects) console.log(`  - ${d}`);
	console.log(`artifact: ${artifactPath} (${result.artifact.length} chars)`);
	console.log(result.ok ? "RESULT: ok" : "RESULT: incomplete");

	return result.ok ? 0 : 1;
}
