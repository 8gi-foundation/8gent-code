import { describe, expect, test } from "bun:test";
import { coarseLeaks, createMasker, describeCounts } from "./mask";

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
		[
			"secret (private key block)",
			"-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----",
			"MIIEabc",
		],
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
		expect(c).toEqual({ secret: 1, email: 1, phone: 0, ip: 1, path: 0, card: 0, term: 1 });
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

describe("masker: a stray brace cannot shield a secret", () => {
	const cases: [string, string][] = [
		["password=hunter2secret{{x}}tail", "hunter2secret"],
		["API_KEY=abc123def456{{ ghi789", "abc123def456"],
		["token={{x}}realsecretvalue99", "realsecretvalue99"],
		["secret={{EMAIL_1}}extrasecretbits", "extrasecretbits"],
	];
	for (const [input, needle] of cases) {
		test(input, () => {
			const m = fresh();
			const out = m.mask(input);
			expect(out).not.toContain(needle);
			expect(m.unmask(out)).toBe(input);
		});
	}

	test("a value that is exactly one of our own placeholders is left as is", () => {
		const m = fresh();
		const once = m.mask(`${EMAIL} and secret=abcdefghij`);
		expect(m.mask(once)).toBe(once);
	});
});

describe("masker: more shapes", () => {
	const FW = "\uFF1A"; // full-width colon
	const cases: [string, string, string][] = [
		["stripe live key", `use sk_live_${"51HabcDEF123456789xyz"} now`, "51HabcDEF123456789xyz"],
		["stripe publishable", `pk_test_${"TYooMQauvdEDq54NiTphI7jx"}`, "TYooMQauvdEDq54NiTphI7jx"],
		["stripe restricted", `rk_live_${"abcdefghijklmnop1234"}`, "abcdefghijklmnop1234"],
		["PRIVATE_KEY name", "PRIVATE_KEY=abcd1234wxyz", "abcd1234wxyz"],
		["STRIPE_KEY name", "STRIPE_KEY=zzzzzzzz1111", "zzzzzzzz1111"],
		["AWS_ACCESS_KEY_ID name", "AWS_ACCESS_KEY_ID=wxyzwxyz1234", "wxyzwxyz1234"],
		["auth name", "auth=letmein123", "letmein123"],
		["dsn name", "SENTRY_DSN=https-ish-value-123", "https-ish-value-123"],
		["quoted password with spaces", 'password = "my long pass phrase"', "my long pass phrase"],
		[".env line", "DATABASE_HOST=db-internal-7", "db-internal-7"],
		[".env export line", "export CLIENT_NAME='Zenith Bank Ltd'", "Zenith Bank Ltd"],
		["url userinfo with password", "postgres://admin:s3cretpw@db.internal:5432/app", "s3cretpw"],
		["url userinfo, user only", "mongodb://deploytoken123@localhost/app", "deploytoken123"],
		["https token userinfo", "https://abc123tokenvalue@github.com/org/repo", "abc123tokenvalue"],
		["Authorization: Token", "Authorization: Token abc123xyz789", "abc123xyz789"],
		["Authorization: bare", "authorization=rawcredential99", "rawcredential99"],
		["curl -u", "curl -u alice:wonderland99 https://x.test", "wonderland99"],
		["curl --user", "curl --user bob:builder123 https://x.test", "builder123"],
		["card number (luhn ok)", "card 4111 1111 1111 1111 exp", "4111 1111 1111 1111"],
		["card number dashes", "4111-1111-1111-1111", "4111-1111-1111-1111"],
		["amex 15 digits", "378282246310005", "378282246310005"],
		[
			"ssh-ed25519 line",
			`ssh-ed25519 ${"AAAAC3NzaC1lZDI1NTE5AAAAIabcdefgh12345"} me@laptop`,
			"AAAAC3NzaC1lZDI1NTE5",
		],
		["ssh-rsa line", `ssh-rsa ${"AAAAB3NzaC1yc2EAAAADAQABAAABgQDabc123"}`, "AAAAB3NzaC1yc2E"],
		[
			"npm token",
			`npm_${"abcdefghijklmnopqrstuvwxyz0123456789"}`,
			"abcdefghijklmnopqrstuvwxyz0123456789",
		],
		["full-width colon", `password${FW}hunter2secret`, "hunter2secret"],
		["non-ASCII email local part", "write to jos\u00e9.mu\u00f1oz@empresa.es today", "mu\u00f1oz"],
		[
			"cyrillic email",
			"\u0438\u0432\u0430\u043d@\u043f\u043e\u0447\u0442\u0430.\u0440\u0444",
			"\u0438\u0432\u0430\u043d",
		],
		["compressed ipv6", "host 2001:db8::1 is up", "2001:db8::1"],
		["compressed ipv6 long", "fe80::1ff:fe23:4567:890a", "fe80::1ff:fe23:4567:890a"],
		["full ipv6", "2001:0db8:85a3:0000:0000:8a2e:0370:7334", "8a2e:0370"],
	];
	for (const [name, input, needle] of cases) {
		test(name, () => {
			const m = fresh();
			const out = m.mask(input);
			expect(out).not.toContain(needle);
			expect(out).toContain("{{");
			expect(m.unmask(out)).toBe(input);
		});
	}

	test("a 16 digit number that fails Luhn is not a card", () => {
		expect(fresh().mask("order 1234567812345678 shipped")).toBe("order 1234567812345678 shipped");
	});
	test("::1, a time and a C++ scope are not IPv6", () => {
		const s = "loopback ::1 at 12:30:45 calls std::string::size";
		expect(fresh().mask(s)).toBe(s);
	});
	test("a plain git remote and a plain 'key' word survive", () => {
		const s = "press any key to continue";
		expect(fresh().mask(s)).toBe(s);
	});
});

describe("masker: hostile input stays fast", () => {
	const N = 16 * 1024;
	const hostile: [string, string][] = [
		["long run", "a1".repeat(N / 2)],
		["many at-signs", "a@".repeat(N / 2)],
		["dotted labels", `x@${"a.".repeat(N / 2)}`],
		["digits and spaces", "1 ".repeat(N / 2)],
		["equals run", `key${"=".repeat(N)}`],
		["keyword repeats", "key=".repeat(N / 4)],
		["braces", "{{".repeat(N / 2)],
		["home paths", "/Users/a".repeat(N / 8)],
		["colons", ":".repeat(N)],
		["hex colons", "a:".repeat(N / 2)],
		["dash digits", "1-".repeat(N / 2)],
		["unclosed pem", `-----BEGIN PRIVATE KEY-----${"x".repeat(N)}`],
		["url schemes", "a://".repeat(N / 4)],
		["upper env", "AAA=".repeat(N / 4)],
	];
	for (const [name, text] of hostile) {
		test(`${name}: mask and coarse check under 250 ms`, () => {
			const m = fresh(["Falcon"]);
			const t0 = performance.now();
			const out = m.mask(text);
			m.leaks(out);
			coarseLeaks(out);
			expect(performance.now() - t0).toBeLessThan(250);
		});
	}
});

describe("coarseLeaks: an independent last check", () => {
	test("flags credentials in a URL, a mixed-case value after =, and a 40+ char token", () => {
		expect(coarseLeaks("postgres://u:p@host/db")).toBe(true);
		expect(coarseLeaks("thing=AbCdEfGhIjKlMnOpQrStUv")).toBe(true);
		expect(coarseLeaks(`x ${"k".repeat(40)} y`)).toBe(true);
	});
	test("passes ordinary text and masked text", () => {
		expect(coarseLeaks("why does the loop at line 40 return 404?")).toBe(false);
		expect(coarseLeaks("secret={{SECRET_1}} mail {{EMAIL_1}}")).toBe(false);
	});
	test("catches a shape the masker does not know", () => {
		const m = fresh();
		const unknown = `vendor-ref: ${"Zq".repeat(25)}`;
		expect(m.leaks(m.mask(unknown))).toBe(false);
		expect(coarseLeaks(m.mask(unknown))).toBe(true);
	});
});
