/**
 * The PLAN column receives statuses from the real update_plan tool (#3035).
 *
 * A scripted model reply goes through the real text-tool parser and loop, the
 * call runs on the real ToolExecutor, and the tool-start args are applied the
 * way app.tsx onToolStart applies them. Not covered here: Agent's own wrapper
 * that fires onToolStart (packages/eight/agent.ts runTextToolChat), which is
 * unchanged and fires for every tool.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { render } from "ink";
import { findPlanFile } from "../../../../../packages/ai/plan-file.js";
import { toolDefsToSpecs } from "../../../../../packages/ai/text-tool-endpoint.js";
import { type TextTool, runTextToolAgent } from "../../../../../packages/ai/text-tool-loop.js";
import { ToolExecutor } from "../../../../../packages/eight/tools.js";
import {
	type PlanStep,
	applyPlanUpdate,
	holdOpenBoxes,
	planFileTally,
	settlePlan,
} from "../../lib/plan-state.js";
import { PlanPanel } from "../PlanPanel.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

async function lastFrame(node: React.ReactElement): Promise<string> {
	const frames: string[] = [];
	const out = Object.assign(new EventEmitter(), {
		columns: 40,
		rows: 20,
		isTTY: false,
		write: (s: string) => {
			frames.push(strip(s));
			return true;
		},
	});
	const app = render(node, {
		stdout: out as unknown as NodeJS.WriteStream,
		debug: true,
		patchConsole: false,
	});
	await new Promise((r) => setTimeout(r, 60));
	app.unmount();
	return frames.at(-1) ?? "";
}

const call = (plan: unknown) =>
	`\`\`\`tool_call\n${JSON.stringify({ name: "update_plan", arguments: { plan } })}\n\`\`\``;

describe("PLAN column from update_plan", () => {
	test("statuses the agent reports tick, fail and mark the current step", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-column-"));
		try {
			const executor = new ToolExecutor(root);
			const specs = toolDefsToSpecs(
				executor.getToolDefinitions() as Parameters<typeof toolDefsToSpecs>[0],
				new Set(["update_plan"]),
			);
			expect(specs.map((s) => s.name)).toEqual(["update_plan"]);

			let steps: PlanStep[] = [];
			const snapshots: PlanStep[][] = [];
			const results: string[] = [];
			const tools: TextTool[] = specs.map((spec) => ({
				spec,
				run: async (args) => {
					// What app.tsx onToolStart does with an update_plan call.
					const items = (args as { plan?: unknown }).plan;
					if (Array.isArray(items)) steps = applyPlanUpdate(steps, items);
					snapshots.push(steps);
					const result = await executor.execute(spec.name, args);
					results.push(result);
					return result;
				},
			}));

			const replies = [
				call([
					{ step: "Read the package", status: "in_progress" },
					{ step: "Write the outline", status: "pending" },
					{ step: "Save it", status: "pending" },
				]),
				call([
					{ step: "Read the package", status: "done" },
					{ step: "Write the outline", status: "failed" },
					{ step: "Save it", status: "in_progress" },
				]),
				"DONE: read the package; the outline failed, so it is not saved.",
			];
			let i = 0;
			const res = await runTextToolAgent({
				messages: [{ role: "user", content: "Outline the package." }],
				tools,
				call: async () => replies[i++] ?? "DONE:",
			});

			expect(res.toolLog.map((t) => t.name)).toEqual(["update_plan", "update_plan"]);
			expect(results).toEqual([
				"Plan updated: 0 of 3 done. Current: Read the package",
				"Plan updated: 1 of 3 done, 1 failed. Current: Save it",
			]);
			expect(snapshots[0]?.map((s) => s.status)).toEqual(["active", "pending", "pending"]);
			expect(snapshots[1]?.map((s) => s.status)).toEqual(["done", "failed", "active"]);
			// Ids stay stable across updates, so rows do not re-land.
			expect(snapshots[1]?.map((s) => s.id)).toEqual(snapshots[0]?.map((s) => s.id));

			// Turn ends: the still-active step goes back to pending, never ticked.
			const settled = settlePlan(steps);
			const frame = await lastFrame(
				<PlanPanel steps={settled} running={false} elapsedMs={9000} width={30} animate={false} />,
			);
			expect(frame).toContain("✓ Read the package");
			expect(frame).toContain("✗ Write the outline");
			expect(frame).not.toContain("✓ Save it");
			expect(frame).toContain("1 of 3 done · 1 failed");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	// #4161: the project's PLAN.md is the record. A done the file has not
	// ticked is refused by the tool and not ticked in the column, and the
	// column shows the file's own count beside its own.
	test("a step whose PLAN.md box is open is refused and not ticked; the file's count shows", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-column-file-"));
		try {
			fs.writeFileSync(
				path.join(root, "PLAN.md"),
				"- [x] 1. Add src/slugify.ts with a test under test/\n- [ ] 2. Update the Usage line in README.md\n",
			);
			const executor = new ToolExecutor(root);
			const items = [
				{ step: "Add src/slugify.ts + test under test/", status: "done" },
				{ step: "Update README.md Usage line", status: "done" },
			];
			// What app.tsx onToolStart does with an update_plan call.
			const file = findPlanFile(root);
			const steps = applyPlanUpdate([], holdOpenBoxes(items, file));
			const result = await executor.execute("update_plan", { plan: items });

			expect(result).toStartWith(
				"Error: update_plan: the plan of record is PLAN.md; tick its boxes with edit_file",
			);
			expect(result).toContain("PLAN.md item 2");
			expect(steps.map((s) => s.status)).toEqual(["done", "pending"]);

			const frame = await lastFrame(
				<PlanPanel
					steps={steps}
					running={true}
					width={30}
					animate={false}
					planFile={planFileTally(file)}
				/>,
			);
			expect(frame).toMatch(/PLAN\s+1\/2/);
			expect(frame).toMatch(/PLAN\.md\s+1\/2/);
			expect(frame).toContain("✓ Add src/slugify.ts");
			expect(frame).not.toContain("✓ Update README.md");

			// No plan file: the column and the tool behave as before.
			fs.rmSync(path.join(root, "PLAN.md"));
			expect(holdOpenBoxes(items, findPlanFile(root))).toEqual(items);
			expect(await executor.execute("update_plan", { plan: items })).toBe(
				"Plan updated: 2 of 2 done",
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
