/**
 * Hands tool registration shim for the computer channel.
 *
 * The agent already has `desktop_*` tools wired into packages/computer (used by
 * apps/lil-eight). This module is the daemon-side surface that mounts the same
 * tool family for the new computer channel: it exposes the OpenAI-style tool
 * definitions, an executor, and a NemoClaw policy gate so every call goes
 * through default-policies.yaml (`desktop_use` rules).
 *
 * `packages/hands` (the planned trycua/cua fork) is a placeholder today; once
 * driver code lands, swap the imports below from `../../computer` to `../../hands`.
 * The agent-facing surface stays identical.
 */

import { evaluatePolicy } from "../../permissions/policy-engine";
import {
  screenshot as desktopScreenshot,
  click as desktopClick,
  typeText as desktopType,
  press as desktopPress,
  scroll as desktopScroll,
  drag as desktopDrag,
  hover as desktopHover,
  windowList as desktopWindowList,
  clipboardGet as desktopClipboardGet,
  clipboardSet as desktopClipboardSet,
  listProcesses as desktopListProcesses,
  quitProcess as desktopQuitProcess,
  quitByName as desktopQuitByName,
  suggestQuittable as desktopSuggestQuittable,
  loadSafeList as desktopLoadSafeList,
  addToSafeList as desktopAddToSafeList,
  removeFromSafeList as desktopRemoveFromSafeList,
  getToolDefinitions as getDesktopToolDefs,
} from "../../computer";

export interface HandsToolCtx {
  sessionId: string;
  /**
   * Asks the user (via the daemon's approval queue) whether to allow a
   * NemoClaw require_approval action. Default: deny.
   */
  approve?: (req: { tool: string; input: unknown; reason: string }) => Promise<boolean>;
}

/**
 * Tool definitions for the agent loop. Reuses the `desktop_*` set already
 * defined in packages/computer to avoid drift; the names also match the
 * existing case branches in packages/eight/tools.ts.
 */
export function getHandsToolDefinitions(): object[] {
  return getDesktopToolDefs();
}

/**
 * Names list for downstream logging / system-prompt generation.
 */
export const HANDS_TOOL_NAMES = [
  "desktop_screenshot",
  "desktop_click",
  "desktop_type",
  "desktop_press",
  "desktop_scroll",
  "desktop_drag",
  "desktop_hover",
  "desktop_windows",
  "desktop_clipboard",
  "desktop_processes",
  "desktop_quit_app",
  "desktop_suggest_quit",
  "desktop_safe_list",
  "desktop_accessibility_tree",
  "desktop_list_apps",
] as const;

/** Map a tool name to the NemoClaw `desktop_use` action descriptor. */
function policyActionFor(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (tool) {
    case "desktop_screenshot":
      return { action: "screenshot" };
    case "desktop_click":
      return { action: "click" };
    case "desktop_type":
      return { action: "type" };
    case "desktop_press":
      return { action: "press", keys: input.keys };
    case "desktop_scroll":
      return { action: "scroll" };
    case "desktop_drag":
      return { action: "drag" };
    case "desktop_hover":
      return { action: "hover" };
    case "desktop_windows":
    case "desktop_list_apps":
      return { action: "window_list" };
    case "desktop_clipboard":
      return { action: input.action === "set" ? "clipboard_set" : "clipboard_get" };
    case "desktop_processes":
      return { action: "list_processes" };
    case "desktop_quit_app":
      return { action: "quit_app" };
    case "desktop_suggest_quit":
      return { action: "suggest_quit" };
    case "desktop_safe_list":
      return { action: "safe_list" };
    case "desktop_accessibility_tree":
      return { action: "screenshot" }; // read-only equivalent under default policy
    default:
      return { action: tool };
  }
}

/**
 * Run a hands tool call through the policy engine and dispatch to the driver.
 * Returns `{ ok: true, result }` or `{ ok: false, reason }`.
 *
 * The first call to a `require_approval` tool produces a one-time prompt via
 * `ctx.approve`. If the approver is missing, the call is denied.
 */
export async function executeHandsTool(
  tool: string,
  input: Record<string, unknown>,
  ctx: HandsToolCtx,
): Promise<{ ok: true; result: unknown } | { ok: false; reason: string }> {
  const policyCtx = policyActionFor(tool, input);
  const decision = evaluatePolicy("desktop_use", policyCtx);

  if (!decision.allowed && decision.requiresApproval) {
    if (!ctx.approve) {
      return { ok: false, reason: `[policy] ${decision.reason} (no approver wired)` };
    }
    const approved = await ctx.approve({ tool, input, reason: decision.reason ?? "approval required" });
    if (!approved) return { ok: false, reason: `[policy] user denied: ${decision.reason}` };
  } else if (!decision.allowed) {
    return { ok: false, reason: `[policy] ${decision.reason}` };
  }

  try {
    const result = await dispatch(tool, input);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function dispatch(tool: string, input: Record<string, unknown>): Promise<unknown> {
  switch (tool) {
    case "desktop_screenshot":
      return desktopScreenshot({ path: input.path as string | undefined, displayId: input.displayId as number | undefined });
    case "desktop_click":
      return desktopClick({
        point: { x: Number(input.x), y: Number(input.y) },
        button: input.button as "left" | "right" | "middle" | undefined,
        count: input.count as number | undefined,
      });
    case "desktop_type":
      return desktopType({ text: String(input.text ?? ""), delay: input.delay as number | undefined });
    case "desktop_press":
      return desktopPress({ keys: String(input.keys ?? ""), count: input.count as number | undefined, delay: input.delay as number | undefined });
    case "desktop_scroll":
      return desktopScroll({
        direction: input.direction as "up" | "down" | "left" | "right",
        amount: input.amount as number | undefined,
        point: input.x !== undefined && input.y !== undefined
          ? { x: Number(input.x), y: Number(input.y) }
          : undefined,
      });
    case "desktop_drag":
      return desktopDrag({
        from: { x: Number(input.fromX), y: Number(input.fromY) },
        to: { x: Number(input.toX), y: Number(input.toY) },
        button: input.button as "left" | "right" | "middle" | undefined,
        duration: input.duration as number | undefined,
      });
    case "desktop_hover":
      return desktopHover({ x: Number(input.x), y: Number(input.y) });
    case "desktop_windows":
    case "desktop_list_apps":
      return desktopWindowList();
    case "desktop_clipboard":
      return input.action === "set"
        ? desktopClipboardSet(String(input.text ?? ""))
        : desktopClipboardGet();
    case "desktop_processes":
      return desktopListProcesses((input.sort as "memory" | "cpu" | "name" | undefined) ?? "memory");
    case "desktop_quit_app":
      if (input.pid !== undefined) {
        return desktopQuitProcess(Number(input.pid), (input.strategy as "graceful" | "force" | undefined) ?? "graceful");
      }
      return desktopQuitByName(String(input.name ?? ""), (input.strategy as "graceful" | "force" | undefined) ?? "graceful");
    case "desktop_suggest_quit":
      return desktopSuggestQuittable();
    case "desktop_safe_list":
      if (input.action === "add") return desktopAddToSafeList(String(input.app ?? ""));
      if (input.action === "remove") return desktopRemoveFromSafeList(String(input.app ?? ""));
      return desktopLoadSafeList();
    case "desktop_accessibility_tree":
      // Driver-level a11y tree is not yet exposed in packages/computer; return a
      // structured stub the agent can reason about until 8gent-hands lands.
      return { ok: false, error: "accessibility_tree not yet available; use desktop_screenshot + desktop_windows" };
    default:
      throw new Error(`hands tool not implemented: ${tool}`);
  }
}
