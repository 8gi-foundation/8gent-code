/**
 * uid-generator.test.ts
 * Smoke tests for all uid-generator exports.
 * Run with: bun packages/tools/uid-generator.test.ts
 */

import {
  shortId,
  prefixedId,
  timestampId,
  sequentialId,
  randomHex,
  slug,
  hashId,
} from "./uid-generator";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  [pass] ${label}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${label}${detail ? ` - ${detail}` : ""}`);
    failed++;
  }
}

// shortId
console.log("\nshortId");
const sid = shortId();
assert("default length 8", sid.length === 8, `got "${sid}"`);
assert("alphanumeric only", /^[0-9A-Za-z]+$/.test(sid));
assert("custom length 12", shortId(12).length === 12);
assert("shortId(4) works", shortId(4).length === 4);
try { shortId(3); assert("throws on len<4", false); } catch { assert("throws on len<4", true); }

// prefixedId
console.log("\nprefixedId");
const pid = prefixedId("usr");
assert("has prefix", pid.startsWith("usr_"));
assert("correct total format", /^usr_[0-9A-Za-z]{8}$/.test(pid));
assert("custom len", /^task_[0-9A-Za-z]{12}$/.test(prefixedId("task", 12)));
try { prefixedId("bad-prefix"); assert("throws on non-alphanumeric prefix", false); } catch { assert("throws on non-alphanumeric prefix", true); }

// timestampId
console.log("\ntimestampId");
const tid = timestampId();
assert("matches hex-hex pattern", /^[0-9a-f]+-[0-9a-f]+$/.test(tid), `got "${tid}"`);
assert("different each call", timestampId() !== timestampId());

// sequentialId
console.log("\nsequentialId");
const seq1 = sequentialId();
const seq2 = sequentialId();
assert("format matches", /^\d{6}-[0-9A-Za-z]{4}$/.test(seq1), `got "${seq1}"`);
assert("monotonically increases", seq1 < seq2);

// randomHex
console.log("\nrandomHex");
const hex = randomHex();
assert("default length 16", hex.length === 16);
assert("hex chars only", /^[0-9a-f]+$/.test(hex));
assert("custom length 8", randomHex(8).length === 8);
assert("custom length 32", randomHex(32).length === 32);

// slug
console.log("\nslug");
const s1 = slug("Hello World!");
assert("lowercase and hyphenated", s1.startsWith("hello-world-"), `got "${s1}"`);
assert("different suffix each call", slug("Hello World!") !== slug("Hello World!"));
try { slug(""); assert("throws on empty string", false); } catch { assert("throws on empty string", true); }

// hashId
console.log("\nhashId");
const h1 = hashId("hello");
assert("deterministic", h1 === hashId("hello"));
assert("default length 16", h1.length === 16);
assert("hex chars only", /^[0-9a-f]+$/.test(h1));
assert("custom length 32", hashId("hello", 32).length === 32);
assert("different content - different hash", hashId("foo") !== hashId("bar"));
try { hashId(""); assert("throws on empty content", false); } catch { assert("throws on empty content", true); }
try { hashId("x", 3); assert("throws on len<4", false); } catch { assert("throws on len<4", true); }

// Summary
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
