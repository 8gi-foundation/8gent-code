/**
 * A YAML hook that answers without reading stdin (`echo '{"block": true}'`) can exit before the
 * payload is written. The EPIPE on the pipe used to be an unhandled 'error' event, an uncaught
 * exception that failed whatever was running (tool-gate.test.ts on the Linux runner, 11 Oct).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HookManager } from "./index";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaml-hook-nostdin-"));
const saved = process.env.EIGHT_HOOKS_YAML;

beforeAll(() => {
	const script = path.join(root, "block.sh");
	fs.writeFileSync(script, `echo '{"block": true, "reason": "frozen"}'\n`);
	const yaml = path.join(root, "hooks.yaml");
	fs.writeFileSync(yaml, `- event: PreToolUse\n  matcher: "*"\n  command: sh '${script}'\n`);
	process.env.EIGHT_HOOKS_YAML = yaml;
});
afterAll(() => {
	if (saved === undefined) Reflect.deleteProperty(process.env, "EIGHT_HOOKS_YAML");
	else process.env.EIGHT_HOOKS_YAML = saved;
	fs.rmSync(root, { recursive: true, force: true });
});

// POSIX only: the hook is an sh script.
test.skipIf(process.platform === "win32")("a hook that never reads stdin still answers, however large the payload", async () => {
	const manager = new HookManager(path.join(root, "none.json"));
	expect(manager.getYamlHookCount()).toBe(1);
	// Larger than the pipe buffer, so the write is still in flight when the hook exits.
	const payload = { tool: "write_file", blob: "x".repeat(4 * 1024 * 1024) };
	for (let i = 0; i < 5; i++) {
		const r = await manager.fire("PreToolUse", payload);
		expect(r.blocked).toBe(true);
		expect(r.reason).toBe("frozen");
	}
});
