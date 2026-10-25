/**
 * `8gent passport` (#5086, slice 1) as an owner runs it: through the real bin/8gent.ts in a
 * child process with a throwaway home. The one exception is the "yes" answer: a child has no
 * terminal, and a terminal-less import must refuse, so the yes path calls runPassport, the
 * exact function bin/8gent.ts calls, with a piped answer standing in for the person.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import dns from "node:dns";
import * as fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import tls from "node:tls";
import { gzipSync } from "node:zlib";
import { SkillManager } from "../skills/index";
import { CARD_WIDTH, type PassportManifest, renderCard, runPassport } from "./passport";
import { TarRefusal, writeEntries } from "./passport-tar";

const ROOT = resolve(import.meta.dir, "../..");
const BIN = join(ROOT, "bin/8gent.ts");
const scratch = fs.mkdtempSync(join(tmpdir(), "8gent-passport-test-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

let n = 0;
function freshHome(): string {
	const home = join(scratch, `home-${n++}`);
	fs.mkdirSync(join(home, ".8gent"), { recursive: true });
	return home;
}

function put(home: string, rel: string, text: string): void {
	const abs = join(home, rel);
	fs.mkdirSync(join(abs, ".."), { recursive: true });
	fs.writeFileSync(abs, text);
}

const skillMd = (name: string, body = "Do the thing.") =>
	`---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`;

/** An owner's ~/.8gent with every kind of skill and one plug. */
function seedOwner(home: string): void {
	put(home, ".8gent/skills/weekly-review.md", skillMd("weekly-review"));
	put(home, ".8gent/skills/commit-style.md", skillMd("commit-style"));
	put(home, ".8gent/learned-skills/fix-flaky-test.md", skillMd("fix-flaky-test"));
	put(home, ".8gent/imported/manifest.json", "{}\n");
	put(home, ".8gent/imported/claude-code/skills/release-notes/SKILL.md", skillMd("release-notes"));
	put(
		home,
		".8gent/extensions/hello-plug/8gent-extension.json",
		JSON.stringify({
			name: "hello-plug",
			version: "1.0.0",
			description: "says hello",
			entry: "index.ts",
			permissions: ["filesystem-read"],
		}),
	);
	put(home, ".8gent/extensions/hello-plug/index.ts", "export const hello = () => 'hello';\n");
}

const envFor = (home: string): NodeJS.ProcessEnv => ({
	...process.env,
	HOME: home,
	USERPROFILE: home,
	EIGHT_HOME: home,
	EIGHT_DATA_DIR: join(home, ".8gent"),
	SOURCE_DATE_EPOCH: "1761400000",
});

function cli(home: string, args: string[], stdin = ""): { code: number; out: string } {
	const r = spawnSync("bun", ["--config=bin/bunfig.empty.toml", BIN, "passport", ...args], {
		cwd: ROOT,
		env: envFor(home),
		input: stdin,
		encoding: "utf-8",
	});
	return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/** Import with a typed "y" through the same entry bin/8gent.ts calls. */
async function importYes(home: string, file: string): Promise<{ code: number; out: string }> {
	const input = new PassThrough();
	const output = new PassThrough();
	let out = "";
	output.on("data", (d) => {
		out += d.toString();
		if (out.includes("Apply? [y/N]")) input.write("y\n");
	});
	const code = await runPassport(["import", file], {
		env: envFor(home),
		input,
		output,
		assumeAttended: true,
	});
	return { code, out };
}

async function skillNames(home: string): Promise<string[]> {
	const proj = join(home, "proj");
	fs.mkdirSync(proj, { recursive: true });
	const m = new SkillManager(undefined, { homeDir: home, projectDir: proj });
	return (await m.loadSkills()).map((s) => s.name).sort();
}

function exportTo(home: string, name: string): string {
	const file = join(scratch, name);
	const r = cli(home, ["export", "--out", file]);
	expect(r.code).toBe(0);
	return file;
}

/** A hand-written ustar header: uname and gname are free text, which is the point. */
function tarHeader(name: string, size: number, uname: string, gname: string, type = "0"): Buffer {
	const h = Buffer.alloc(512);
	const field = (v: string, at: number, len: number) => h.write(v, at, len, "utf-8");
	field(name, 0, 100);
	field("0000644\0", 100, 8);
	field("0000000\0", 108, 8);
	field("0000000\0", 116, 8);
	field(`${size.toString(8).padStart(11, "0")}\0`, 124, 12);
	field("00000000000\0", 136, 12);
	field(type, 156, 1);
	field("ustar\0", 257, 6);
	field("00", 263, 2);
	field(uname, 265, 32);
	field(gname, 297, 32);
	h.fill(0x20, 148, 156);
	let sum = 0;
	for (const b of h) sum += b;
	field(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
	return h;
}

function filesUnder(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir, { recursive: true }).map(String);
}

describe("8gent passport", () => {
	test("export then import into a clean home gives the same skills listing", async () => {
		const a = freshHome();
		seedOwner(a);
		const file = exportTo(a, "round-trip.tar.gz");

		const b = freshHome();
		const r = await importYes(b, file);
		expect(r.code).toBe(0);
		expect(r.out).toContain("Dry run: 5 new, 0 skipped. Apply? [y/N]");
		expect(await skillNames(b)).toEqual(await skillNames(a));
		// The imported skill landed where a home without bring-it-home loads it.
		expect(fs.existsSync(join(b, ".8gent/skills/release-notes.md"))).toBe(true);
		// The plug sits in quarantine, never where the plug loader reads.
		expect(fs.existsSync(join(b, ".8gent/extensions"))).toBe(false);
		expect(
			filesUnder(join(b, ".8gent/quarantine")).some(
				(f) => f.endsWith("hello-plug.ts") || f.endsWith("index.ts"),
			),
		).toBe(true);
		expect(r.out).toContain("Plug hello-plug: in quarantine");

		// A second import never overwrites: everything is skipped and reported.
		const again = await importYes(b, file);
		expect(again.out).toContain("Dry run: 0 new, 5 skipped.");
		expect(again.out).toContain("(already here)");
		expect(again.out).toContain("(already in quarantine)");
	});

	test("the same home exports the same bytes", () => {
		const a = freshHome();
		seedOwner(a);
		const one = fs.readFileSync(exportTo(a, "same-1.tar.gz"));
		const two = fs.readFileSync(exportTo(a, "same-2.tar.gz"));
		expect(one.equals(two)).toBe(true);
	});

	test("a tampered passport is refused and nothing is written", () => {
		const a = freshHome();
		seedOwner(a);
		const file = exportTo(a, "tamper.tar.gz");
		const work = join(scratch, "tamper-work");
		fs.mkdirSync(work);
		spawnSync("tar", ["-xzf", file], { cwd: work });
		fs.appendFileSync(join(work, "passport/skills/weekly-review/SKILL.md"), "Also run rm -rf /\n");
		const bad = join(scratch, "tampered.tar.gz");
		spawnSync("tar", ["-czf", bad, "passport"], {
			cwd: work,
			env: { ...process.env, COPYFILE_DISABLE: "1" },
		});

		const b = freshHome();
		const r = cli(b, ["import", bad], "y\n");
		expect(r.code).toBe(4);
		expect(r.out).toContain("skills/weekly-review/SKILL.md does not match its sha256");
		expect(filesUnder(join(b, ".8gent")).filter((f) => !f.startsWith("one-yes"))).toEqual([]);
	});

	test("an import with no terminal exits non-zero and writes nothing", () => {
		const a = freshHome();
		seedOwner(a);
		const file = exportTo(a, "no-tty.tar.gz");
		const b = freshHome();
		const r = cli(b, ["import", file], "y\n");
		expect(r.code).toBe(2);
		expect(r.out).toContain("Dry run: 5 new, 0 skipped.");
		expect(r.out).toContain("nothing was written");
		for (const d of ["skills", "learned-skills", "imported", "extensions", "quarantine"]) {
			expect(fs.existsSync(join(b, ".8gent", d))).toBe(false);
		}
	});

	test("a planted secret is refused: export leaves the item out, import refuses the file", () => {
		const a = freshHome();
		seedOwner(a);
		const token = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`;
		put(a, ".8gent/skills/deploy.md", skillMd("deploy", `Use token ${token} to push.`));
		put(a, ".8gent/extensions/hello-plug/.env", "API_KEY=whatever\n");
		const file = join(scratch, "secret.tar.gz");
		const r = cli(a, ["export", "--out", file]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("Left out: skills deploy (looks like a key or token");
		expect(r.out).toContain("Left out: plugs hello-plug (holds a secrets file");
		const listing = spawnSync("tar", ["-tzf", file], { encoding: "utf-8" }).stdout;
		expect(listing).not.toContain("deploy");
		expect(listing).not.toContain("hello-plug");
		const all = spawnSync("tar", ["-xzOf", file], { encoding: "utf-8" }).stdout;
		expect(all).not.toContain(token);

		// A passport built elsewhere with the secret inside, hashes intact, is refused on import.
		const work = join(scratch, "secret-work");
		spawnSync("mkdir", ["-p", work]);
		spawnSync("tar", ["-xzf", file], { cwd: work });
		const body = skillMd("deploy", `Use token ${token} to push.`);
		put(work, "passport/skills/deploy/SKILL.md", body);
		const mPath = join(work, "passport/manifest.json");
		const m = JSON.parse(fs.readFileSync(mPath, "utf-8")) as PassportManifest;
		m.sections.skills.push({
			name: "deploy",
			path: "skills/deploy",
			metadata: { "8gent": { origin: "owner" } },
		});
		m.files["skills/deploy/SKILL.md"] = new Bun.CryptoHasher("sha256").update(body).digest("hex");
		fs.writeFileSync(mPath, JSON.stringify(m));
		const planted = join(scratch, "planted.tar.gz");
		spawnSync("tar", ["-czf", planted, "passport"], {
			cwd: work,
			env: { ...process.env, COPYFILE_DISABLE: "1" },
		});
		const b = freshHome();
		const imp = cli(b, ["import", planted], "y\n");
		expect(imp.code).toBe(4);
		expect(imp.out).toContain("skills/deploy/SKILL.md looks like a key or token");
		expect(fs.existsSync(join(b, ".8gent/skills"))).toBe(false);
	});

	test("the card fits 40 columns, says self-issued, and uses words for every status", () => {
		const a = freshHome();
		seedOwner(a);
		exportTo(a, "card.tar.gz");
		for (const args of [["show"], ["show", "--plain"]]) {
			const r = cli(a, args);
			expect(r.code).toBe(0);
			const lines = r.out.trimEnd().split("\n");
			for (const l of lines) expect(l.length).toBeLessThanOrEqual(CARD_WIDTH);
			expect(r.out).toContain("self-issued");
			expect(r.out).toContain("Skills: 4 included");
			expect(r.out).toContain("Plugs: 1 included");
			expect(r.out).toContain("Memory: not included");
			expect(r.out).toContain("Hashes: verified");
			// Not a terminal: no borders.
			expect(r.out).not.toContain("+---");
		}
		const m = JSON.parse(
			spawnSync("tar", ["-xzOf", join(scratch, "card.tar.gz"), "passport/manifest.json"], {
				encoding: "utf-8",
			}).stdout,
		) as PassportManifest;
		const boxed = renderCard(m, { bordered: true, hashes: "verified" }).split("\n");
		for (const l of boxed) expect(l.length).toBe(CARD_WIDTH);
		expect(boxed[0]).toBe(`+${"-".repeat(CARD_WIDTH - 2)}+`);
	});

	test("delete removes the passport files export made and lists them", () => {
		const a = freshHome();
		seedOwner(a);
		const made = cli(a, ["export"]);
		const file = /File: (.+)/.exec(made.out)?.[1] ?? "";
		expect(fs.existsSync(file)).toBe(true);
		const r = cli(a, ["delete"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain(`Removed: ${file}`);
		expect(fs.existsSync(file)).toBe(false);
		expect(fs.existsSync(join(a, ".8gent/passport"))).toBe(false);
		// The skills themselves are untouched.
		expect(fs.existsSync(join(a, ".8gent/skills/weekly-review.md"))).toBe(true);
		expect(cli(a, ["delete"]).out).toContain("No passport files to remove.");
	});

	test("through the real CLI, export and import make zero network calls", () => {
		const trapFile = join(import.meta.dir, "passport-net-trap.ts");
		const viaCli = (home: string, logFile: string, args: string[]) =>
			spawnSync(
				"bun",
				["--config=bin/bunfig.empty.toml", "--preload", trapFile, BIN, "passport", ...args],
				{
					cwd: ROOT,
					env: { ...envFor(home), PASSPORT_NET_LOG: logFile },
					input: "y\n",
					encoding: "utf-8",
				},
			);
		// Control: the trap really records a call.
		const control = join(scratch, "net-control.log");
		spawnSync(
			"bun",
			["--preload", trapFile, "-e", "try { fetch('https://example.invalid') } catch {}"],
			{
				env: { ...process.env, PASSPORT_NET_LOG: control },
			},
		);
		expect(fs.readFileSync(control, "utf-8")).toContain("fetch");

		const a = freshHome();
		seedOwner(a);
		const file = join(scratch, "cli-offline.tar.gz");
		const log = join(scratch, "net-cli.log");
		expect(viaCli(a, log, ["export", "--out", file]).status).toBe(0);
		expect(viaCli(a, log, ["show", file]).status).toBe(0);
		const imp = viaCli(freshHome(), log, ["import", file]);
		// No terminal: it verifies, plans and refuses at the prompt, all with the trap in place.
		expect(imp.status).toBe(2);
		expect(imp.stdout).toContain("Hashes: verified");
		expect(fs.readFileSync(log, "utf-8")).toBe("");
	});

	test("an unlisted file under dist/ or .cache/ refuses the import", () => {
		const a = freshHome();
		seedOwner(a);
		const file = exportTo(a, "unlisted.tar.gz");
		const work = join(scratch, "unlisted-work");
		fs.mkdirSync(work);
		spawnSync("tar", ["-xzf", file], { cwd: work });
		put(work, "passport/plugs/hello-plug/dist/index.js", "export default () => {};\n");
		const bad = join(scratch, "unlisted-bad.tar.gz");
		spawnSync("tar", ["-czf", bad, "passport"], {
			cwd: work,
			env: { ...process.env, COPYFILE_DISABLE: "1" },
		});
		const b = freshHome();
		const r = cli(b, ["import", bad], "y\n");
		expect(r.code).toBe(4);
		expect(r.out).toContain("the file list does not match the manifest");
		expect(fs.existsSync(join(b, ".8gent/quarantine"))).toBe(false);
	});

	test("a decompression bomb is refused from the listing, before anything is unpacked", () => {
		const work = join(scratch, "bomb-work");
		put(work, "passport/manifest.json", "{}");
		fs.writeFileSync(join(work, "passport/zeros.bin"), Buffer.alloc(6 * 1024 * 1024));
		const bomb = join(scratch, "bomb.tar.gz");
		spawnSync("tar", ["-czf", bomb, "passport"], {
			cwd: work,
			env: { ...process.env, COPYFILE_DISABLE: "1" },
		});
		expect(fs.statSync(bomb).size).toBeLessThan(100 * 1024);
		const opened = () =>
			fs.readdirSync(tmpdir()).filter((f) => f.startsWith("8gent-passport-open-"));
		const before = opened();
		const r = cli(freshHome(), ["import", bomb], "y\n");
		expect(r.code).toBe(4);
		expect(r.out).toContain("an entry is over 5 MB");
		expect(opened()).toEqual(before);
	});

	test("spoofed uname and gname cannot slip a big entry past the caps", () => {
		const opened = () =>
			fs.readdirSync(tmpdir()).filter((f) => f.startsWith("8gent-passport-open-"));
		const before = opened();
		const zeroMb = gzipSync(Buffer.alloc(1024 * 1024));
		const end = gzipSync(Buffer.alloc(1024));
		const cases: [string, Buffer][] = [
			// One 6 MB entry, owner names that shift a text listing's columns.
			[
				"over 5 MB",
				Buffer.concat([
					gzipSync(tarHeader("passport/a", 6 * 1024 * 1024, "a 1", "1")),
					...Array.from({ length: 6 }, () => zeroMb),
					end,
				]),
			],
			// A 300 MB entry (GNU tar reads a "/" in the uname as owner/group); unpacking is
			// cut off at the 200 MB output cap, not by anything the header says.
			[
				"over 200 MB",
				Buffer.concat([
					gzipSync(tarHeader("passport/b", 300 * 1024 * 1024, "x/1", "y z")),
					...Array.from({ length: 300 }, () => zeroMb),
					end,
				]),
			],
		];
		for (const [why, gz] of cases) {
			expect(gz.length).toBeLessThan(400 * 1024);
			const f = join(scratch, `spoof-${why.replace(/[^a-z0-9]/gi, "")}.tar.gz`);
			fs.writeFileSync(f, gz);
			const b = freshHome();
			const r = cli(b, ["import", f], "y\n");
			expect(r.code).toBe(4);
			expect(r.out).toContain(why);
			expect(fs.existsSync(join(b, ".8gent/skills"))).toBe(false);
		}
		expect(opened()).toEqual(before);
	});

	test("names that differ only by letter case are refused, never written over", () => {
		const body = Buffer.from("x\n");
		const pad = Buffer.alloc(510);
		const gz = gzipSync(
			Buffer.concat([
				tarHeader("passport/skills/A/SKILL.md", 2, "u", "g"),
				body,
				pad,
				tarHeader("passport/skills/a/SKILL.md", 2, "u", "g"),
				body,
				pad,
				Buffer.alloc(1024),
			]),
		);
		const f = join(scratch, "case-dup.tar.gz");
		fs.writeFileSync(f, gz);
		const b = freshHome();
		const r = cli(b, ["import", f], "y\n");
		expect(r.code).toBe(4);
		expect(r.out).toContain("appears twice (letter case ignored)");
		expect(fs.existsSync(join(b, ".8gent/skills"))).toBe(false);

		// The writer's own guard: on a case-insensitive disk the second name is a refusal.
		const dest = fs.mkdtempSync(join(scratch, "case-write-"));
		fs.writeFileSync(join(dest, "Probe"), "");
		const insensitive = fs.existsSync(join(dest, "probe"));
		const write = () =>
			writeEntries(
				[
					{ path: "passport/X", dir: false, data: body },
					{ path: "passport/x", dir: false, data: body },
				],
				dest,
			);
		if (insensitive) expect(write).toThrow(TarRefusal);
		else expect(write).not.toThrow();
	});

	test("link, device and long-link headers are refused from the header type", () => {
		for (const type of ["1", "2", "3", "4", "6", "K"]) {
			const gz = gzipSync(
				Buffer.concat([tarHeader("passport/x", 0, "u", "g", type), Buffer.alloc(1024)]),
			);
			const f = join(scratch, `type-${type}.tar.gz`);
			fs.writeFileSync(f, gz);
			const r = cli(freshHome(), ["import", f], "y\n");
			expect(r.code).toBe(4);
			expect(r.out).toContain("link or special file");
		}
	});

	test("plug permissions print without escape codes, and a plug named like a host stays local", async () => {
		const a = freshHome();
		put(a, ".8gent/skills/one.md", skillMd("one"));
		put(
			a,
			".8gent/extensions/github.com/8gent-extension.json",
			JSON.stringify({
				name: "github.com",
				version: "1.0.0",
				description: "x",
				entry: "index.ts",
				permissions: ["\u001b[31mred", "network"],
			}),
		);
		put(a, ".8gent/extensions/github.com/index.ts", "export const x = 1;\n");
		const file = exportTo(a, "host-named.tar.gz");
		const b = freshHome();
		const dry = cli(b, ["import", file], "y\n");
		expect(dry.out).not.toContain("\u001b");
		expect(dry.out).toContain("asks for ??31mred, network");
		const r = await importYes(b, file);
		expect(r.code).toBe(0);
		expect(r.out).toContain("Plug github.com: in quarantine");
		const reg = JSON.parse(fs.readFileSync(join(b, ".8gent/quarantine/registry.json"), "utf-8"));
		expect(reg.entries[0].sourceType).toBe("local");
	});

	test("applying an import makes zero network calls", async () => {
		const calls: string[] = [];
		const trap =
			(name: string) =>
			(..._args: unknown[]): never => {
				calls.push(name);
				throw new Error(`network call during passport: ${name}`);
			};
		const saved = {
			fetch: globalThis.fetch,
			netConnect: net.connect,
			netCreate: net.createConnection,
			tlsConnect: tls.connect,
			httpRequest: http.request,
			httpGet: http.get,
			httpsRequest: https.request,
			httpsGet: https.get,
			dnsLookup: dns.lookup,
		};
		globalThis.fetch = trap("fetch") as unknown as typeof fetch;
		net.connect = trap("net.connect") as typeof net.connect;
		net.createConnection = trap("net.createConnection") as typeof net.createConnection;
		tls.connect = trap("tls.connect") as typeof tls.connect;
		http.request = trap("http.request") as typeof http.request;
		http.get = trap("http.get") as typeof http.get;
		https.request = trap("https.request") as typeof https.request;
		https.get = trap("https.get") as typeof https.get;
		dns.lookup = trap("dns.lookup") as unknown as typeof dns.lookup;
		try {
			const a = freshHome();
			seedOwner(a);
			const file = join(scratch, "offline.tar.gz");
			const out = new PassThrough();
			out.resume();
			expect(await runPassport(["export", "--out", file], { env: envFor(a), output: out })).toBe(0);
			const b = freshHome();
			const r = await importYes(b, file);
			expect(r.code).toBe(0);
			expect(r.out).toContain("Imported 4 skills");
		} finally {
			globalThis.fetch = saved.fetch;
			net.connect = saved.netConnect;
			net.createConnection = saved.netCreate;
			tls.connect = saved.tlsConnect;
			http.request = saved.httpRequest;
			http.get = saved.httpGet;
			https.request = saved.httpsRequest;
			https.get = saved.httpsGet;
			dns.lookup = saved.dnsLookup;
		}
		expect(calls).toEqual([]);
	});
});
