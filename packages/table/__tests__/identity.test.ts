/**
 * Identity tests: mint/load/ensure idempotence, sign/verify round-trip, 0600
 * private-key perms, and negative cases (tampered message / signature / wrong
 * participant).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type KeyDir,
	ensureIdentity,
	fileBaseFor,
	loadIdentity,
	mintIdentity,
	publicKeyOf,
	signMessage,
	verifyMessage,
} from "../identity.js";

let dir: KeyDir;

const JAMES = "human:james";
const AGENT_8EO = "agent:8EO";

beforeEach(() => {
	dir = { root: fs.mkdtempSync(path.join(os.tmpdir(), "table-keys-")) };
});

afterEach(() => {
	try {
		fs.rmSync(dir.root, { recursive: true, force: true });
	} catch {
		// best effort
	}
});

describe("file-base mapping", () => {
	it("maps human/agent ids to distinct file bases", () => {
		expect(fileBaseFor(JAMES)).toBe("james");
		expect(fileBaseFor(AGENT_8EO)).toBe("agent-8EO");
	});

	it("rejects unprefixed or traversal ids", () => {
		expect(() => fileBaseFor("james")).toThrow();
		expect(() => fileBaseFor("human:../etc/passwd")).toThrow();
		expect(() => fileBaseFor("other:x")).toThrow();
	});
});

describe("mint / load / ensure", () => {
	it("mints a keypair, writes private 0600 + public, and is idempotent", () => {
		const id = mintIdentity(JAMES, dir);
		expect(id.participantId).toBe(JAMES);
		expect(id.publicKeyPem).toContain("BEGIN PUBLIC KEY");

		const priv = path.join(dir.root, "james.ed25519");
		const pub = path.join(dir.root, "james.ed25519.pub");
		expect(fs.existsSync(priv)).toBe(true);
		expect(fs.existsSync(pub)).toBe(true);

		// 0600 on the private key (POSIX only; skip the assert on platforms that ignore mode).
		if (process.platform !== "win32") {
			const mode = fs.statSync(priv).mode & 0o777;
			expect(mode).toBe(0o600);
		}

		// Idempotent: minting again returns the same public key, no overwrite.
		const again = mintIdentity(JAMES, dir);
		expect(again.publicKeyPem).toBe(id.publicKeyPem);
	});

	it("loadIdentity returns null before mint, the identity after", () => {
		expect(loadIdentity(AGENT_8EO, dir)).toBeNull();
		const id = ensureIdentity(AGENT_8EO, dir);
		expect(loadIdentity(AGENT_8EO, dir)?.publicKeyPem).toBe(id.publicKeyPem);
		expect(publicKeyOf(AGENT_8EO, dir)).toBe(id.publicKeyPem);
	});
});

describe("sign / verify", () => {
	it("round-trips a signature (mints lazily on first sign)", () => {
		const msg = "chan_abc|human:james|hello|1234";
		const sig = signMessage(JAMES, msg, dir);
		expect(sig.length).toBeGreaterThan(0);
		expect(verifyMessage(JAMES, msg, sig, dir)).toBe(true);
	});

	it("fails verification on a tampered message", () => {
		const sig = signMessage(JAMES, "original", dir);
		expect(verifyMessage(JAMES, "tampered", sig, dir)).toBe(false);
	});

	it("fails verification on a tampered signature", () => {
		const sig = signMessage(JAMES, "original", dir);
		const bad = `${sig.slice(0, -2)}${sig.endsWith("AA") ? "BB" : "AA"}`;
		expect(verifyMessage(JAMES, "original", bad, dir)).toBe(false);
	});

	it("fails verification against a different participant's key", () => {
		const msg = "same message";
		const sig = signMessage(JAMES, msg, dir);
		ensureIdentity(AGENT_8EO, dir);
		expect(verifyMessage(AGENT_8EO, msg, sig, dir)).toBe(false);
	});

	it("returns false (never throws) verifying an unknown participant", () => {
		expect(verifyMessage("human:ghost", "x", "AAAA", dir)).toBe(false);
	});
});
