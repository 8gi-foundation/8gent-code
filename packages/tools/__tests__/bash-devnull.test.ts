import { describe, expect, test } from "bun:test";
import { gateBashCommand } from "../bash-tool";

// A local model told to open a local page reached for `2>/dev/null` and `>/dev/null 2>&1` four times;
// the path guard refused each as a device file and the turn ran out of time (browser-op-practice).
describe("redirects to the null sink pass the bash gate", () => {
	for (const cmd of [
		"which xdg-open 2>/dev/null",
		"(xdg-open http://127.0.0.1:1/ || open http://127.0.0.1:1/) >/dev/null 2>&1; echo opened",
		"curl -s http://127.0.0.1:1/ > /dev/null",
		"cat < /dev/null",
	])
		test(`allows: ${cmd}`, () => expect(gateBashCommand(cmd, "a", "/tmp").decision.allowed).toBe(true));

	// Only the exact null path is a sink; every other device file stays refused.
	for (const cmd of ["echo x > /dev/tty", "echo x > /dev/null/../tty"])
		test(`still refuses: ${cmd}`, () => expect(gateBashCommand(cmd, "a", "/tmp").decision.allowed).toBe(false));
});
