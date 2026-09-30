import { describe, expect, test } from "bun:test";
import { BlockedDestinationError, checkDestination, classifyAddress } from "../net-guard";

describe("classifyAddress (#3233)", () => {
	const blocked: Array<[string, RegExp]> = [
		["0.0.0.0", /unspecified/],
		["127.0.0.1", /loopback/],
		["127.255.255.254", /loopback/],
		["10.1.2.3", /private/],
		["172.16.0.1", /private/],
		["172.31.255.255", /private/],
		["192.168.1.1", /private/],
		["100.64.0.1", /carrier-grade/],
		["100.100.100.200", /carrier-grade/],
		["169.254.169.254", /metadata/],
		["192.0.0.192", /IETF/],
		["198.18.0.1", /benchmarking/],
		["224.0.0.1", /multicast/],
		["255.255.255.255", /reserved/],
		["::", /unspecified/],
		["::1", /loopback/],
		["::ffff:127.0.0.1", /IPv4-mapped.*loopback/],
		["::ffff:7f00:1", /IPv4-mapped.*loopback/],
		["::ffff:a9fe:a9fe", /IPv4-mapped.*169\.254\.169\.254/],
		["0:0:0:0:0:ffff:c0a8:0101", /IPv4-mapped.*192\.168\.1\.1/],
		["::127.0.0.1", /IPv4-compatible/],
		["64:ff9b::a9fe:a9fe", /NAT64.*169\.254\.169\.254/],
		["2002:7f00:1::", /6to4.*127\.0\.0\.1/],
		["2001:0:4136:e378:8000:63bf:3fff:fdd2", /Teredo/],
		["fd00:ec2::254", /unique local/],
		["fc00::1", /unique local/],
		["fe80::1", /link-local/],
		["fe80::1%en0", /link-local/],
		["fec0::1", /site-local/],
		["ff02::1", /multicast/],
		["2001:db8::1", /documentation/],
		["100::1", /not global unicast/],
		["not-an-ip", /not an IP/],
	];
	for (const [ip, why] of blocked) {
		test(`refuses ${ip}`, () => {
			expect(classifyAddress(ip)).toMatch(why);
		});
	}

	for (const ip of [
		"93.184.216.34",
		"8.8.8.8",
		"172.32.0.1",
		"100.128.0.1",
		"2606:4700::1111",
		"2002:808:808::",
	]) {
		test(`allows public ${ip}`, () => {
			expect(classifyAddress(ip)).toBeNull();
		});
	}
});

describe("checkDestination (#3233)", () => {
	const noDns = async () => {
		throw new Error("resolver must not be called");
	};

	test("refuses non-http schemes", async () => {
		await expect(checkDestination("file:///etc/passwd")).rejects.toBeInstanceOf(
			BlockedDestinationError,
		);
		await expect(checkDestination("ftp://example.com/")).rejects.toThrow(/scheme/);
	});

	test("refuses local names without resolving them", async () => {
		for (const u of [
			"http://localhost/",
			"http://LOCALHOST./",
			"http://printer.local/",
			"http://router.home.arpa/",
			"http://metadata.google.internal/",
		]) {
			await expect(checkDestination(u, { resolve: noDns })).rejects.toThrow(/Refused/);
		}
	});

	test("refuses a host with an empty DNS answer or a failed lookup", async () => {
		await expect(
			checkDestination("http://a.example/", { resolve: async () => [] }),
		).rejects.toThrow(/did not resolve/);
		await expect(
			checkDestination("http://a.example/", {
				resolve: async () => {
					throw new Error("ENOTFOUND");
				},
			}),
		).rejects.toThrow(/DNS lookup failed/);
	});

	test("returns the checked address to pin", async () => {
		const d = await checkDestination("https://a.example:8443/x", {
			resolve: async () => [{ address: "93.184.216.34", family: 4 }],
		});
		expect(d.address).toBe("93.184.216.34");
		expect(d.literal).toBe(false);
		expect(d.url.host).toBe("a.example:8443");
	});
});
