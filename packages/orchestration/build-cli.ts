/**
 * build-cli.ts - CLI entry for the mixture-of-agents project build.
 *
 * Backs `8gent build "<task>"`. Unlike `8gent pipeline` (one self-corrected
 * file), this decomposes the task into one-file units, has a tool-capable agent
 * (ornith) build each through its own loop, verifies each landed, and escalates
 * to a stronger executor on failure - all narrated as structured events.
 *
 *   8gent build "A tiny static site with an about and contact page"
 *   8gent build --type next-app --out ./site "A portfolio landing page"
 *   8gent build --events http://localhost:7890/pipeline "<task>"   # stream to Flow
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ProjectPipeline } from "./project-pipeline.js";

export async function runBuildCommand(args: string[]): Promise<number> {
	let outDir = resolve(process.cwd(), "build-output");
	let projectType = "next-app";
	let httpSink: string | undefined;
	const taskParts: string[] = [];

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--out" && args[i + 1]) outDir = resolve(args[++i]);
		else if (args[i] === "--type" && args[i + 1]) projectType = args[++i];
		else if (args[i] === "--events" && args[i + 1]) httpSink = args[++i];
		else if (!args[i].startsWith("-")) taskParts.push(args[i]);
	}
	const task = taskParts.join(" ").trim();

	if (!task) {
		console.error('Usage: 8gent build [--type next-app|static-site] [--out <dir>] [--events <url>] "<task>"');
		console.error("Mixture-of-agents build: scaffold -> decompose -> agent-execute -> verify -> escalate.");
		return 1;
	}

	mkdirSync(outDir, { recursive: true });
	console.log("8gent build (mixture-of-agents)");
	console.log(`task : ${task}`);
	console.log(`type : ${projectType}`);
	console.log(`out  : ${outDir}`);
	console.log("");

	const pipe = await ProjectPipeline.create({
		task,
		workingDirectory: outDir,
		projectType,
		httpSink,
		onProgress: (line) => console.log(`  ${line}`),
	});
	const res = await pipe.run();

	console.log("");
	console.log(`units  : ${res.unitsPlanned} planned`);
	for (const u of res.units) {
		console.log(`  ${u.ok ? "ok  " : "FAIL"} ${u.path.padEnd(28)} ${u.model} (x${u.attempts})`);
	}
	console.log(`files  : ${res.filesWritten.join(", ") || "(none)"}`);
	console.log(`compile: ${res.compileOk ? "ok" : res.compileDetail}`);
	console.log(res.ok ? "RESULT: ok" : "RESULT: incomplete");
	console.log(`\nopen ${outDir}`);

	return res.ok ? 0 : 1;
}
