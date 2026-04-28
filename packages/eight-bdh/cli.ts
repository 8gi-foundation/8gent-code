#!/usr/bin/env bun
/**
 * @8gent/eight-bdh CLI - Phase 0 surface.
 *
 * Subcommands:
 *   decide  - run inference (stub decision until weights land)
 *   info    - print model id, package version, config
 *   detect  - delegate to scripts/detect-compute.ts
 *
 * Spec: docs/specs/8GENT-0.1-BDH-ORCHESTRATOR.md §9 Phase 0 ship gate.
 */

import { PHASE_0_5M_CONFIG } from "./types";
import type {
	OrchestratorInput,
	Decision,
	AuditTrace,
	HarnessSnapshot,
	AuthorityPolicy,
} from "./types";

const PACKAGE_VERSION = "0.1.0";
const MODEL_ID = "8gent-0.1.0-bdh-r:10m";

function parseArgs(argv: string[]): {
	command: string;
	flags: Record<string, string>;
} {
	const [command = "info", ...rest] = argv;
	const flags: Record<string, string> = {};
	for (let i = 0; i < rest.length; i++) {
		const tok = rest[i];
		if (tok && tok.startsWith("--")) {
			const key = tok.slice(2);
			const next = rest[i + 1];
			if (next === undefined || next.startsWith("--")) {
				flags[key] = "true";
			} else {
				flags[key] = next;
				i++;
			}
		}
	}
	return { command, flags };
}

function stubDecide(input: OrchestratorInput): {
	decision: Decision;
	trace: AuditTrace;
} {
	const decision: Decision = {
		kind: "clarify",
		target: "stub-no-weights-loaded",
		budget: { tokens: 0, ms: 0 },
		confidence: 0,
	};
	const trace: AuditTrace = {
		synapseIds: ["stub:no-model-loaded"],
		topActivations: [{ concept: "stub:no-model-loaded", weight: 1.0 }],
		reasoningChain: [
			`Phase 0 stub. Echoed request: ${input.request.slice(0, 120)}`,
			"No weights loaded; returning a clarify decision so callers fail closed.",
		],
	};
	return { decision, trace };
}

async function cmdDecide(flags: Record<string, string>): Promise<void> {
	const request = flags.request;
	if (!request) {
		console.error("decide: --request <text> is required");
		process.exit(2);
	}

	let context: HarnessSnapshot = {};
	if (flags["state-json"]) {
		try {
			context = JSON.parse(flags["state-json"]) as HarnessSnapshot;
		} catch (err) {
			console.error(
				`decide: --state-json failed to parse: ${(err as Error).message}`,
			);
			process.exit(2);
		}
	}

	const policy: AuthorityPolicy = {
		authority_level: Number.parseInt(flags["authority"] ?? "1", 10) as
			| 0
			| 1
			| 2
			| 3
			| 4
			| 5,
	};

	const input: OrchestratorInput = { request, context, policy };
	const { decision, trace } = stubDecide(input);
	console.log(JSON.stringify({ decision, trace }, null, 2));
}

function cmdInfo(): void {
	console.log(
		JSON.stringify(
			{
				package: "@8gent/eight-bdh",
				version: PACKAGE_VERSION,
				model_id: MODEL_ID,
				phase: "0",
				status: "scaffold-only-no-weights",
				config_phase_0_5m: PHASE_0_5M_CONFIG,
			},
			null,
			2,
		),
	);
}

async function cmdDetect(): Promise<void> {
	const url = new URL("./scripts/detect-compute.ts", import.meta.url);
	const mod = (await import(url.pathname)) as {
		main?: () => Promise<void> | void;
	};
	if (typeof mod.main === "function") {
		await mod.main();
	} else {
		console.error("detect: scripts/detect-compute.ts has no exported main()");
		process.exit(2);
	}
}

async function main(): Promise<void> {
	const { command, flags } = parseArgs(process.argv.slice(2));
	switch (command) {
		case "decide":
			await cmdDecide(flags);
			return;
		case "info":
			cmdInfo();
			return;
		case "detect":
			await cmdDetect();
			return;
		default:
			console.error(
				`Unknown command: ${command}. Try one of: decide | info | detect`,
			);
			process.exit(2);
	}
}

main().catch((err: Error) => {
	console.error(err.message);
	process.exit(1);
});
