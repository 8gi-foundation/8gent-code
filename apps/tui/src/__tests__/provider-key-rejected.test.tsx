/**
 * The phone case, end to end through the real App. On 7 Nov 2026 a phone picked MiniMax,
 * whose stored key the endpoint refused with 401. The model list request failed, but the
 * models an earlier discovery had recorded in providers.json were still listed, so a model
 * was picked, the first message went out and came back as "all providers failed (1 tried)".
 * Now the refused key stops the switch, with the one command that fixes it, and nothing
 * is sent. The endpoint is a fake served here; the key is a placeholder.
 */
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAppHarness } from "./app-driver.js";

test("a key MiniMax refuses stops the switch and names `8gent keys set minimax`", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-key-rejected-"));
	fs.mkdirSync(path.join(home, ".8gent"), { recursive: true });
	// What an earlier, successful discovery leaves behind.
	fs.writeFileSync(
		path.join(home, ".8gent", "providers.json"),
		JSON.stringify({
			providers: {
				minimax: { models: ["MiniMax-fake-recorded"], defaultModel: "MiniMax-fake-recorded" },
			},
		}),
	);
	const chats: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname.endsWith("/chat/completions")) chats.push(url.pathname);
			return Response.json(
				{ base_resp: { status_code: 2049, status_msg: "invalid api key" } },
				{ status: 401 },
			);
		},
	});
	try {
		const events = await runAppHarness(
			path.join(import.meta.dir, "provider-key-rejected.harness.tsx"),
			{
				HOME: home,
				USERPROFILE: home,
				EIGHT_HOME: home,
				EIGHT_DATA_DIR: path.join(home, ".8gent"),
				MINIMAX_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
				MINIMAX_API_KEY: "test-placeholder-not-a-key",
			},
		);
		expect(events.find((e) => e.phase === "error")).toBeUndefined();
		const phone = events.find((e) => e.phase === "phone");
		expect(phone?.rejected).toBeTrue();
		expect(phone?.command).toBeTrue();
		expect(phone?.nothingRun).toBeTrue();
		expect(phone?.bareCount).toBeFalse();
		expect(chats).toEqual([]);
	} finally {
		server.stop(true);
	}
}, 120_000);
