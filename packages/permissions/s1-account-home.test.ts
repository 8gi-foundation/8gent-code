/** #4073: the account home comes from the account database on each platform, never from $HOME. */
import { describe, expect, test } from "bun:test";
import { homeFromDscl, homeFromPasswd, passwdHomeFor } from "./s1-account-home";

describe("account home lookup", () => {
	test("parses getent and /etc/passwd lines by uid", () => {
		const t = "root:x:0:0:root:/root:/bin/bash\njames:x:1000:1000:J,,,:/home/james:/bin/zsh\n";
		expect(homeFromPasswd(t, 1000)).toBe("/home/james");
		expect(homeFromPasswd(t, 0)).toBe("/root");
		expect(homeFromPasswd(t, 5)).toBeNull();
		expect(homeFromPasswd("a:x:7:7::relative:/bin/sh", 7)).toBeNull();
	});

	test("parses dscl output", () => {
		expect(homeFromDscl("NFSHomeDirectory: /Users/james\n")).toBe("/Users/james");
		expect(homeFromDscl("nothing here")).toBeNull();
	});

	test("linux: getent first, /etc/passwd second, null when neither works", () => {
		const calls: string[][] = [];
		const getent = (f: string, a: string[]) => {
			calls.push([f, ...a]);
			return "james:x:1000:1000::/home/james:/bin/sh\n";
		};
		expect(passwdHomeFor("linux", 1000, getent)).toBe("/home/james");
		expect(calls[0]).toEqual(["/usr/bin/getent", "passwd", "1000"]);
		const broken = () => {
			throw new Error("no getent");
		};
		expect(passwdHomeFor("linux", 1000, broken, () => "james:x:1000:1000::/srv/j:/bin/sh\n")).toBe("/srv/j");
		expect(
			passwdHomeFor("linux", 1000, broken, () => {
				throw new Error("no file");
			}),
		).toBeNull();
	});

	test("macOS: dscl, then the shell's database expansion when the directory service is down", () => {
		const calls: string[][] = [];
		const dscl = (f: string, a: string[]) => {
			calls.push([f, ...a]);
			return "NFSHomeDirectory: /Users/james\n";
		};
		expect(passwdHomeFor("darwin", 501, dscl, undefined, () => "james")).toBe("/Users/james");
		expect(calls[0]).toEqual(["/usr/bin/dscl", ".", "-read", "/Users/james", "NFSHomeDirectory"]);
		const down = (f: string) => {
			if (f === "/usr/bin/dscl") throw new Error("eServerError");
			return "/Users/james\n";
		};
		expect(passwdHomeFor("darwin", 501, down, undefined, () => "james")).toBe("/Users/james");
		expect(passwdHomeFor("darwin", 501, dscl, undefined, () => "../evil")).toBeNull();
	});
});
