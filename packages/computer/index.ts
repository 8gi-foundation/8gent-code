/**
 * 8gent Code - Computer Use (Power #10)
 *
 * Desktop automation for Eight and Lil Eight.
 * Wraps usecomputer (native Zig N-API module) with security guards.
 *
 * All operations go through the NemoClaw policy engine before executing.
 * The agent sees scaled screenshots and uses coord-map to click accurately.
 *
 * @example
 * ```ts
 * import { desktopScreenshot, desktopClick } from "../computer";
 * const shot = desktopScreenshot();
 * // Agent reasons about the screenshot, identifies button at (400, 300)
 * desktopClick({ point: { x: 400, y: 300 } });
 * ```
 */

export {
  screenshot,
  click,
  typeText,
  press,
  scroll,
  drag,
  hover,
  mousePosition,
  windowList,
  displayList,
  clipboardGet,
  clipboardSet,
} from "./bridge";

export {
  listProcesses,
  getMemorySummary,
  quitProcess,
  quitByName,
  suggestQuittable,
  loadSafeList,
  addToSafeList,
  removeFromSafeList,
} from "./process-manager";

export type {
  ProcessInfo,
  SortMode,
  QuitStrategy,
} from "./process-manager";

export {
  createCoordMap,
  imageToDesktop,
  encodeCoordMap,
  decodeCoordMap,
  MAX_SCREENSHOT_DIM,
} from "./coord-map";

export type {
  Point,
  MouseButton,
  ScrollDirection,
  ScreenshotOptions,
  ClickOptions,
  TypeOptions,
  PressOptions,
  ScrollOptions,
  DragOptions,
  CoordMap,
  ScreenshotResult,
  CommandResult,
  WindowInfo,
  DisplayInfo,
  ComputerUseContext,
} from "./types";

/**
 * Tool definitions for Eight's tool executor.
 * These follow the OpenAI function-calling format used by packages/eight/tools.ts.
 */
export function getToolDefinitions(): object[] {
  return [
    {
      type: "function",
      function: {
        name: "desktop_screenshot",
        description: "[DESKTOP] Take a screenshot of the desktop screen. Returns the file path and a coord-map string. Use the coord-map when calling desktop_click/desktop_hover to translate screenshot coordinates to real screen coordinates. Always screenshot before clicking.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path to save screenshot (auto-generated if omitted)" },
            displayId: { type: "number", description: "Display index to capture (default: primary)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "desktop_click",
        description: "[DESKTOP] Click at a point on the desktop screen. Use coordinates from a recent desktop_screenshot (with coord-map awareness). Supports left/right/middle click and double-click.",
        parameters: {
          type: "object",
          properties: {
            x: { type: "number", description: "X coordinate on screen" },
            y: { type: "number", description: "Y coordinate on screen" },
            button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button (default: left)" },
            count: { type: "number", description: "Click count, e.g. 2 for double-click (default: 1, max: 5)" },
            coordMap: { type: "string", description: "Coord-map string from desktop_screenshot to translate image coords to screen coords" },
          },
          required: ["x", "y"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "desktop_type",
        description: "[DESKTOP] Type text at the current cursor position. Click a text field first with desktop_click, then use this to type into it. Max 2000 characters per call.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to type" },
            delay: { type: "number", description: "Delay between keystrokes in ms (default: 0)" },
          },
          required: ["text"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "desktop_press",
        description: "[DESKTOP] Press a key combination. Examples: 'enter', 'cmd+s', 'ctrl+shift+p', 'tab', 'escape', 'backspace'. Dangerous combos (cmd+q, alt+f4) are flagged.",
        parameters: {
          type: "object",
          properties: {
            keys: { type: "string", description: "Key combination, e.g. 'cmd+s', 'ctrl+c', 'enter'" },
            count: { type: "number", description: "Number of times to press (default: 1, max: 5)" },
            delay: { type: "number", description: "Delay between presses in ms (default: 0)" },
          },
          required: ["keys"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "desktop_scroll",
        description: "[DESKTOP] Scroll in a direction. Optionally move cursor to a point first.",
        parameters: {
          type: "object",
          properties: {
            direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Scroll direction" },
            amount: { type: "number", description: "Scroll amount in ticks (default: 3, max: 50)" },
            x: { type: "number", description: "X coordinate to scroll at (optional)" },
            y: { type: "number", description: "Y coordinate to scroll at (optional)" },
          },
          required: ["direction"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "desktop_drag",
        description: "[DESKTOP] Drag from one point to another. Useful for resizing windows, moving files, drawing.",
        parameters: {
          type: "object",
          properties: {
            fromX: { type: "number", description: "Start X coordinate" },
            fromY: { type: "number", description: "Start Y coordinate" },
            toX: { type: "number", description: "End X coordinate" },
            toY: { type: "number", description: "End Y coordinate" },
            button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button (default: left)" },
            duration: { type: "number", description: "Drag duration in ms (default: 500, max: 5000)" },
          },
          required: ["fromX", "fromY", "toX", "toY"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "desktop_hover",
        description: "[DESKTOP] Move the cursor to a point without clicking. Useful for triggering hover states or tooltips.",
        parameters: {
          type: "object",
          properties: {
            x: { type: "number", description: "X coordinate" },
            y: { type: "number", description: "Y coordinate" },
            coordMap: { type: "string", description: "Coord-map string from desktop_screenshot" },
          },
          required: ["x", "y"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "desktop_windows",
        description: "[DESKTOP] List all open windows with their titles, apps, positions, and sizes. Useful for finding which app to interact with.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "desktop_clipboard",
        description: "[DESKTOP] Get or set the system clipboard. Use action 'get' to read, 'set' to write.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["get", "set"], description: "Whether to read or write the clipboard" },
            text: { type: "string", description: "Text to write (only for action='set')" },
          },
          required: ["action"],
        },
      },
    },
    // Process management tools
    {
      type: "function",
      function: {
        name: "desktop_processes",
        description: "[DESKTOP] List running processes with memory and CPU usage. Returns top 50 processes sorted by memory (default), CPU, or name. Use this to identify resource-hogging apps that could be quit to free compute for the user.",
        parameters: {
          type: "object",
          properties: {
            sort: { type: "string", enum: ["memory", "cpu", "name"], description: "Sort order (default: memory - highest first)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "desktop_quit_app",
        description: "[DESKTOP] Quit a running application to free resources. Requires user confirmation. Use 'graceful' (default) to ask the app to save and exit, or 'force' if the app is frozen. System-critical processes (kernel, Finder, Dock, etc.) are hard-blocked. Provide either a PID or app name.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "App name to quit (e.g. 'Slack', 'Spotify', 'Discord')" },
            pid: { type: "number", description: "Process ID to quit (alternative to name)" },
            strategy: { type: "string", enum: ["graceful", "force"], description: "Quit strategy - graceful sends SIGTERM, force sends SIGKILL (default: graceful)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "desktop_suggest_quit",
        description: "[DESKTOP] Suggest apps that could be quit to conserve resources. Shows quittable apps sorted by memory usage, excluding system-critical processes and the user's safe list. Includes a memory summary. Present the suggestions to the user for approval before quitting anything.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "desktop_safe_list",
        description: "[DESKTOP] Manage the safe list - apps that should never be quit during resource cleanup. Actions: 'list' to see current safe apps, 'add' to protect an app, 'remove' to unprotect.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list", "add", "remove"], description: "What to do with the safe list" },
            app: { type: "string", description: "App name to add/remove (required for add/remove)" },
          },
          required: ["action"],
        },
      },
    },
  ];
}
