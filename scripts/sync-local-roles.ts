#!/usr/bin/env bun
/**
 * sync-local-roles.ts - detect locally-available models and write a
 * strength-matched role assignment to ~/.8gent/roles.json.
 *
 * Run whenever the local model lineup changes (new Ollama pull, different
 * LM Studio model loaded). The harness then routes each role to the model
 * best suited for it - no hardcoded model names.
 *
 *   bun run scripts/sync-local-roles.ts          # detect, write, report
 *   bun run scripts/sync-local-roles.ts --dry    # detect and report only
 */

import {
	type DetectedModel,
	detectLocalModels,
	recommendRoleConfig,
} from "../packages/orchestration/local-model-detect";
import { saveRoleConfig } from "../packages/orchestration/role-config";

const dryRun = process.argv.includes("--dry");

const models: DetectedModel[] = await detectLocalModels();

if (models.length === 0) {
	console.error("No local models detected. Checked:");
	console.error("  Ollama            http://localhost:11434/api/tags");
	console.error("  LM Studio         http://localhost:1234/v1/models");
	console.error("  Apple Foundation  ~/.8gent/bin/apple-foundation-bridge");
	console.error("\nroles.json left untouched.");
	process.exit(1);
}

console.log(`Detected ${models.length} local model(s):`);
for (const m of [...models].sort((a, b) => b.score - a.score)) {
	console.log(`  ${m.provider.padEnd(18)} ${m.model.padEnd(36)} score=${m.score}`);
}

const cfg = recommendRoleConfig(models);
if (!cfg) {
	console.error("Could not produce a role config from detected models.");
	process.exit(1);
}

console.log("\nStrength-matched role assignment:");
for (const role of ["orchestrator", "engineer", "qa", "fallback"] as const) {
	console.log(`  ${role.padEnd(14)} ${cfg[role].provider} / ${cfg[role].model}`);
}

if (dryRun) {
	console.log("\n--dry: roles.json not written.");
	process.exit(0);
}

saveRoleConfig(cfg);
console.log("\nWrote ~/.8gent/roles.json");
