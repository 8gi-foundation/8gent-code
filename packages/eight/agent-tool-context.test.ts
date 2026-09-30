/**
 * Constructing an Agent never moves another agent's tool context (#3127).
 *
 * The reproduction on main a01201c4: the orchestrator's Agent was built with
 * /tmp/orchestrator-wd and scope primary, then a second Agent (a Table session)
 * was built in the same process, and the native tools' context became
 * /tmp/subagent-wd, scope __table__, for both. The per-call binding itself is
 * proven through the real SDK loop in packages/ai/tool-context-per-agent.test.ts.
 */

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getToolContext, setToolContext } from "../ai/tools";
import { Agent } from "./agent";

test("a second Agent does not switch the first one's working dir or scope", () => {
	const saved = getToolContext();
	const orchestratorWd = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-wd-"));
	const subagentWd = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-wd-"));
	setToolContext({ workingDirectory: orchestratorWd, agentId: "primary" });
	try {
		new Agent({ model: "eight-1.0-q3:14b", runtime: "ollama", workingDirectory: orchestratorWd });
		new Agent({
			model: "eight-1.0-q3:14b",
			runtime: "ollama",
			workingDirectory: subagentWd,
			agentScope: "__table__",
		});
		expect(getToolContext()).toEqual({ workingDirectory: orchestratorWd, agentId: "primary" });
	} finally {
		setToolContext(saved);
		fs.rmSync(orchestratorWd, { recursive: true, force: true });
		fs.rmSync(subagentWd, { recursive: true, force: true });
	}
});
