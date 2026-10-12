#!/usr/bin/env bun
/**
 * desktop_act dry run: the whole flow (pre-gate, policy, local grounder,
 * mapping, approval, verify) against a saved screenshot, through the real
 * ToolExecutor, with the act recorded instead of executed.
 *
 *   bun packages/eight/scripts/desktop-act-dry.ts <screenshot.png> "<target>" [click|type|press] [text|keys]
 *
 * With no TUI approval handler registered (this script, CI, a pilot) the
 * act is refused by the executor, which is the point: it proves a local
 * model cannot click without a person. First it prints the permission
 * preflight line for this host.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactDesktopArgs } from "../../computer/desktop-approval";
import { desktopPreflight } from "../../computer/preflight";
import { ToolExecutor } from "../tools";

const [image, target, action = "click", extra] = process.argv.slice(2);
if (!image || !target) {
	console.error(
		'usage: desktop-act-dry.ts <screenshot.png> "<target>" [click|type|press] [text|keys]',
	);
	process.exit(2);
}

const pre = desktopPreflight();
console.log(`preflight: ${pre.ok ? `ok (host app: ${pre.app})` : pre.line}`);

process.env.EIGHT_DESKTOP_ACT_DRY = image;
process.env.EIGHT_HEADLESS = process.env.EIGHT_HEADLESS ?? "1";
const exec = new ToolExecutor(mkdtempSync(join(tmpdir(), "desktop-act-dry-")), "desktop-act-dry");
const args: Record<string, unknown> = { target, action };
if (action === "type") args.text = extra;
if (action === "press") args.keys = extra;
console.log(`desktop_act ${JSON.stringify(redactDesktopArgs(args))}`);
const out = await exec.execute("desktop_act", args);
console.log(out);
process.exit(0);
