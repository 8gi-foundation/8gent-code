import { afterEach, describe, expect, test } from "bun:test";
import { type CommandPolicyContext, mustAskReason } from "./command-policy";
import { evaluatePolicy, evaluateToolCall } from "./policy-engine";

const FORMS = [
	"http://169.254.169.254/latest/meta-data/",
	"http://2852039166/latest/meta-data/",
	"http://0251.0376.0251.0376/latest/meta-data/",
	"http://0xa9fea9fe/latest/meta-data/",
	"http://[::ffff:169.254.169.254]/latest/meta-data/",
	"http://169.254.169.254:80/latest/meta-data/",
	"http://user@169.254.169.254/latest/meta-data/",
	"http://169.254.169.254./latest/meta-data/",
	"http://[fd00:ec2::254]/latest/meta-data/",
	"http://%31%36%39.254.169.254/latest/meta-data/",
	"http://169\u3002254\u3002169\u3002254/latest/meta-data/",
	"https://169.254.170.2/v2/credentials",
	"http://metadata.google.internal/computeMetadata/v1/",
	"http://METADATA.GOOGLE.INTERNAL/",
	"http://100.100.100.200/latest/meta-data/",
	"http://192.0.0.192/opc/v2/instance/",
];
const ctx = { pinnedLocalProvider: false } as unknown as CommandPolicyContext;

afterEach(() => {
	process.env.EIGHT_PROVIDERS_ALLOW = undefined as unknown as string;
	// biome-ignore lint/performance/noDelete: an unset variable, not the string "undefined"
	delete process.env.EIGHT_PROVIDERS_ALLOW;
});

const reasonOf = (d: unknown) => (d as { reason?: string }).reason;

describe("tools: web_fetch and network_request to a metadata address are refused", () => {
	for (const url of FORMS) {
		for (const action of ["web_fetch", "network_request"]) {
			test(`${action} ${url}`, () => {
				const d = evaluatePolicy(action, { url });
				expect(d.allowed).toBe(false);
				expect(reasonOf(d)).toContain("cloud_metadata_host");
			});
		}
	}
	test("evaluateToolCall refuses a network request and the reason names the gate", () => {
		const d = evaluateToolCall("web_fetch", { kind: "network", url: FORMS[0] });
		expect(d.allowed).toBe(false);
		expect(reasonOf(d)).toContain("cloud_metadata_host");
	});
	test("an ordinary https fetch still passes", () => {
		expect(evaluatePolicy("network_request", { url: "https://example.com/" }).allowed).toBe(true);
		expect(
			evaluatePolicy("web_fetch", { url: "https://169.254.169.254.example.com/" }).allowed,
		).toBe(true);
	});
});

describe("shell: a command that reaches a metadata address is refused", () => {
	for (const url of FORMS) {
		for (const verb of ["curl -s", "curl -I", "curl -X PUT", "curl --head", "wget -qO-"]) {
			test(`${verb} ${url}`, () => {
				expect(mustAskReason(`${verb} ${url}`, ctx)).toContain("cloud_metadata_host");
			});
		}
	}
	test("the IMDSv2 token dance is refused at the first step", () => {
		const step1 = mustAskReason(
			'curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600"',
			ctx,
		);
		expect(step1).toContain("cloud_metadata_host");
	});
	test("inside a pipe, a sub-shell and an option value", () => {
		expect(mustAskReason("echo x | curl -s http://169.254.169.254/", ctx)).toContain(
			"cloud_metadata_host",
		);
		expect(mustAskReason('sh -c "curl http://2852039166/"', ctx)).toContain("cloud_metadata_host");
		expect(mustAskReason("curl --url=http://0xa9fea9fe/", ctx)).toContain("cloud_metadata_host");
	});
	test("the refusal does not depend on a pinned provider", () => {
		expect(
			mustAskReason("curl -s http://169.254.169.254/", {
				pinnedLocalProvider: true,
			} as unknown as CommandPolicyContext),
		).toContain("cloud_metadata_host");
	});
	test("ordinary commands are untouched", () => {
		expect(mustAskReason("curl -s https://example.com/", ctx)).toBeNull();
		expect(mustAskReason("curl -s http://169.254.169.254.example.com/", ctx)).toBeNull();
		expect(mustAskReason("ls -la", ctx)).toBeNull();
	});
});

describe("always-blocked: a hard deny in every mode", () => {
	test("blockedReason refuses each form for curl and wget, and a URL in any command", async () => {
		const { blockedReason } = await import("./always-blocked");
		for (const url of FORMS) {
			expect(blockedReason(["curl", "-s", url])).toContain("cloud_metadata_host");
			expect(blockedReason(["wget", "-qO-", url])).toContain("cloud_metadata_host");
			expect(blockedReason(["python3", "-c", "x", url])).toContain("cloud_metadata_host");
		}
		expect(blockedReason(["curl", "-s", "https://example.com/"])).toBeNull();
		expect(blockedReason(["ls", "metadata"])).toBeNull();
	});
	test("PermissionManager treats it as always blocked", async () => {
		const { PermissionManager } = await import("./index");
		const pm = new PermissionManager();
		expect(pm.alwaysBlockedReason("curl -s http://169.254.169.254/latest/meta-data/")).toContain(
			"cloud_metadata_host",
		);
		expect(pm.alwaysBlockedReason('sh -c "curl http://2852039166/"')).toContain(
			"cloud_metadata_host",
		);
	});
});
