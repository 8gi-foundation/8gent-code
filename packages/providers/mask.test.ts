import { describe, expect, test } from "bun:test";
import { describeCounts, createMasker } from "./mask";

// Built from pieces so no secret scanner mistakes a fixture for a real key.
const SK = `sk-${"a1B2c3D4e5F6g7H8i9J0"}kLmN`;
const GH = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`;
const AWS = `AKIA${"IOSFODNN7EXAMPLE"}`;
const JWT = `eyJ${"hbGciOiJIUzI1NiJ9"}.eyJ${"zdWIiOiIxMjM0NTY3ODkw"}.${"SflKxwRJSMeKKF2QT4fw"}`;
const EMAIL = "sarah.connor@cyberdyne-systems.com";
const PHONE = "+353 86 123 4567";
const IP = "203.0.113.42";
const HOMEPATH = "/Users/jdoe/clients/zenith-bank/contracts/q3.pdf";
const WINPATH = "C:\\Users\\jdoe\\Documents\\zenith-bank\\notes.txt";

const fresh = (terms: string[] = []) => createMasker({ terms, hostIdentity: false });

describe("masker: each type is replaced and restored", () => {
	const cases: [string, string, string][] = [
		["secret (sk- key)", `the key is ${SK} ok`, SK],
		["secret (github token)", `token ${GH}`, GH],
		["secret (aws access key)", `aws ${AWS}`, AWS],
		["secret (jwt)", `jwt ${JWT}`, JWT],
		["secret (private key block)", "-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----", "MIIEabc"],
		["secret (key=value)", "DB_PASSWORD=hunter2hunter2", "hunter2hunter2"],
		["secret (bearer)", "Authorization: Bearer abcdef0123456789abcdef", "abcdef0123456789abcdef"],
		["email", `mail ${EMAIL} now`, EMAIL],
		["phone", `call ${PHONE}.`, PHONE],
		["ip", `server at ${IP} is down`, IP],
		["posix home path", `see ${HOMEPATH}.`, "zenith-bank"],
		["windows home path", `open ${WINPATH}`, "zenith-bank"],
		["listed term", "Project Falcon is for Initech", "Falcon"],
	];
	for (const [name, input, needle] of cases) {
		test(name, () => {
			const m = fresh(["Falcon", "Initech"]);
			const out = m.mask(input);
			expect(out).not.toContain(needle);
			expect(out).toContain("{{");
			expect(m.unmask(out)).toBe(input);
		});
	}

	test("a reply with placeholders gets the exact originals back", () => {
		const m = fresh(["Initech"]);
		const out = m.mask(`${EMAIL} works at Initech from ${IP}`);
		const reply = `Block ${out.match(/\{\{IP_1\}\}/)?.[0]} and write to ${out.match(/\{\{EMAIL_1\}\}/)?.[0]} at ${out.match(/\{\{TERM_1\}\}/)?.[0]}.`;
		expect(m.unmask(reply)).toBe(`Block ${IP} and write to ${EMAIL} at Initech.`);
	});

	test("unmask leaves a placeholder it did not make", () => {
		expect(fresh().unmask("keep {{EMAIL_9}} as is")).toBe("keep {{EMAIL_9}} as is");
	});
});

describe("masker: placeholders are stable within a request", () => {
	test("same value, same placeholder, across strings and messages", () => {
		const m = fresh(["Initech"]);
		const [a, b] = m.maskMessages([
			{ role: "system", content: `from ${EMAIL} at Initech` },
			{ role: "user", content: `again ${EMAIL}, ${IP}, initech, ${IP}` },
		]);
		const emailPh = a.content.match(/\{\{EMAIL_\d+\}\}/)?.[0];
		expect(emailPh).toBeDefined();
		expect(b.content).toContain(emailPh as string);
		expect(b.content.match(/\{\{IP_1\}\}/g)?.length).toBe(2);
		expect(b.role).toBe("user");
	});

	test("two different values get two different placeholders", () => {
		const m = fresh();
		const out = m.mask("a@example.org and b@example.org");
		expect(out).toBe("{{EMAIL_1}} and {{EMAIL_2}}");
	});

	test("text that already looks like a placeholder is never confused with one", () => {
		const m = fresh();
		const input = `literal {{EMAIL_1}} then real ${EMAIL}`;
		const out = m.mask(input);
		expect(out).not.toContain(EMAIL);
		expect(m.unmask(out)).toBe(input);
	});
});

describe("masker: what is left alone and what is reported", () => {
	test("plain prose, loopback and short numbers are untouched", () => {
		const m = fresh();
		const s = "Why does the loop at 127.0.0.1:3000 return 404 on 2026-10-21 for build 1234?";
		expect(m.mask(s)).toBe(s);
		expect(describeCounts(m.counts())).toBeNull();
	});

	test("counts are by type and hold no values", () => {
		const m = fresh(["Falcon"]);
		m.mask(`${EMAIL} ${EMAIL} ${IP} ${SK} Falcon`);
		const c = m.counts();
		expect(c).toEqual({ secret: 1, email: 1, phone: 0, ip: 1, path: 0, term: 1 });
		const d = describeCounts(c) as string;
		expect(d).toBe("1 secret, 1 email, 1 IP address, 1 listed term");
		for (const v of [EMAIL, IP, SK, "Falcon"]) expect(d).not.toContain(v);
	});

	test("the OS username and home directory are hidden by default", () => {
		const home = require("node:os").homedir();
		const out = createMasker().mask(`cat ${home}/notes/secret-plan.md`);
		expect(out).not.toContain(home);
		expect(out).not.toContain("secret-plan");
	});

	test("leaks() flags unmasked secrets and passes masked text", () => {
		const m = fresh();
		expect(m.leaks(`key ${SK}`)).toBe(true);
		expect(m.leaks(m.mask(`key ${SK} ${EMAIL}`))).toBe(false);
	});
});

describe("masker: the map has no way out", () => {
	test("the object exposes no map, no serialiser and nothing holds originals", () => {
		const m = fresh();
		m.mask(`${EMAIL} ${SK}`);
		expect(Object.keys(m).sort()).toEqual(["counts", "leaks", "mask", "maskMessages", "unmask"]);
		const dumped = JSON.stringify(m) + String(m.counts());
		expect(dumped).not.toContain(EMAIL);
		expect(dumped).not.toContain(SK);
	});
});
