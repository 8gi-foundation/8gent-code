import { describe, expect, test } from "bun:test";
import { findMetadataHost, isCloudMetadataHost } from "./metadata-hosts";

const FORMS: Record<string, string> = {
	"dotted decimal": "169.254.169.254",
	"decimal integer": "2852039166",
	octal: "0251.0376.0251.0376",
	hex: "0xa9fea9fe",
	"mixed octal and hex": "0251.0xfe.169.0376",
	"dotted hex": "0xa9.0xfe.0xa9.0xfe",
	"two-part": "169.254.43518",
	"IPv6 mapped": "::ffff:169.254.169.254",
	"IPv6 mapped hex": "::ffff:a9fe:a9fe",
	"bracketed IPv6 mapped": "[::ffff:169.254.169.254]",
	"with port": "169.254.169.254:80",
	"bracketed with port": "[fd00:ec2::254]:80",
	"with userinfo": "user:pw@169.254.169.254",
	"userinfo trick": "http://example.com@169.254.169.254/latest/meta-data/",
	"trailing dot": "169.254.169.254.",
	"upper case name": "METADATA.GOOGLE.INTERNAL",
	"full URL": "http://169.254.169.254/latest/meta-data/",
	"URL with decimal host": "https://2852039166:443/x",
	"other link-local address": "169.254.0.1",
	"percent-encoded dotted": "http://%31%36%39.254.169.254/",
	"percent-encoded name": "http://metadata%2egoogle%2einternal/",
	"percent-encoded trailing dot": "http://169.254.169.254%2e/",
	"percent-encoded lower and upper": "http://%31%36%39%2E%32%35%34%2e169.254/",
	"ideographic full stop": "169\u3002254\u3002169\u3002254",
	"fullwidth full stop": "169\uff0e254\uff0e169\uff0e254",
	"halfwidth ideographic stop": "169\uff61254\uff61169\uff61254",
	"fullwidth digits": "\uff11\uff16\uff19.\uff12\uff15\uff14.\uff11\uff16\uff19.\uff12\uff15\uff14",
	"fullwidth URL": "http://\uff11\uff16\uff19\u3002\uff12\uff15\uff14\u3002169.254/",
	NAT64: "64:ff9b::a9fe:a9fe",
	"AWS IPv6": "fd00:ec2::254",
	"AWS IPv6 expanded": "fd00:0ec2:0:0:0:0:0:254",
	"IPv6 link-local": "fe80::1",
	"IPv6 link-local upper": "[FEBF::1]",
	"GCP name": "metadata.google.internal",
	"GCP name URL": "http://metadata.google.internal/computeMetadata/v1/",
	"Azure name": "metadata.azure.com",
	"short name": "metadata",
	"instance-data": "instance-data",
	Alibaba: "100.100.100.200",
	Oracle: "192.0.0.192",
};

describe("isCloudMetadataHost: every literal form is a metadata host", () => {
	for (const [name, host] of Object.entries(FORMS)) {
		test(name, () => expect(isCloudMetadataHost(host)).toBe(true));
	}
});

describe("isCloudMetadataHost: ordinary hosts are not", () => {
	for (const host of [
		"169.255.0.1",
		"169.253.255.255",
		"10.0.0.1",
		"127.0.0.1",
		"192.0.0.191",
		"100.100.100.201",
		"example.com",
		"https://example.com/metadata",
		"169.254.169.254.example.com",
		"%zz.example.com",
		"64:ff9b::808:808",
		"http://169.254.169.254.example.com/",
		"metadata.example.com",
		"fec0::1",
		"::1",
		"2606:4700::1111",
		"::ffff:10.0.0.1",
		"",
	]) {
		test(JSON.stringify(host), () => expect(isCloudMetadataHost(host)).toBe(false));
	}
});

describe("findMetadataHost", () => {
	test("finds a URL, an option value and an embedded URL", () => {
		expect(findMetadataHost(["-s", "http://169.254.169.254/x"])).not.toBeNull();
		expect(findMetadataHost(["--url=http://2852039166/"])).not.toBeNull();
		expect(findMetadataHost(["-H", "x", "see http://0xa9fea9fe/y"])).not.toBeNull();
	});
	test("passes ordinary words", () => {
		expect(findMetadataHost(["-s", "https://example.com/a", "-o", "out.txt"])).toBeNull();
	});
});

describe("bare names are whole-word only", () => {
	test("substrings and option values are not hosts", () => {
		expect(findMetadataHost(["--name=metadata"])).toBeNull();
		expect(findMetadataHost(["metadata.json"])).toBeNull();
		expect(findMetadataHost(["my-metadata"])).toBeNull();
		expect(findMetadataHost(["metadata"])).toBe("metadata");
		expect(findMetadataHost(["--url=http://metadata/"])).not.toBeNull();
	});
});
