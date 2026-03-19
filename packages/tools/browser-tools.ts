/**
 * Browser tools for 8gent-code agent.
 * Uses agent-browser CLI (must be installed: npm install -g agent-browser)
 */

import { execSync } from "child_process";

// ============================================
// Types
// ============================================

export interface BrowserSnapshot {
  elements: Array<{ ref: string; role: string; name: string; value?: string }>;
  url: string;
  title: string;
}

export interface BrowserToolOptions {
  timeout?: number;
}

// ============================================
// BrowserTools class
// ============================================

export class BrowserTools {
  private timeout: number;

  constructor(options?: BrowserToolOptions) {
    this.timeout = options?.timeout ?? 30000;
  }

  /** Check if agent-browser is installed */
  isAvailable(): boolean {
    try {
      execSync("which agent-browser", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  /** Open a URL in the browser */
  open(url: string): string {
    return this.exec(`open ${url}`);
  }

  /** Get accessibility snapshot (best for AI - returns element refs) */
  snapshot(): BrowserSnapshot {
    const raw = this.exec("snapshot");
    return this.parseSnapshot(raw);
  }

  /** Get interactive-only accessibility snapshot */
  snapshotInteractive(): BrowserSnapshot {
    const raw = this.exec("snapshot -i");
    return this.parseSnapshot(raw);
  }

  /** Click an element by ref or selector */
  click(selector: string): string {
    return this.exec(`click ${selector}`);
  }

  /** Fill an input field (clears first) */
  fill(selector: string, text: string): string {
    return this.exec(`fill ${selector} "${text.replace(/"/g, '\\"')}"`);
  }

  /** Type text into an element (append mode) */
  type(selector: string, text: string): string {
    return this.exec(`type ${selector} "${text.replace(/"/g, '\\"')}"`);
  }

  /** Press a key (Enter, Tab, Escape, etc.) */
  press(key: string): string {
    return this.exec(`press ${key}`);
  }

  /** Take a screenshot */
  screenshot(path: string): string {
    return this.exec(`screenshot ${path}`);
  }

  /** Take a full-page screenshot */
  screenshotFull(path: string): string {
    return this.exec(`screenshot --full ${path}`);
  }

  /** Get page text content */
  text(): string {
    return this.exec("text");
  }

  /** Get page source HTML */
  source(): string {
    return this.exec("source");
  }

  /** Scroll the page */
  scroll(direction: "up" | "down" | "left" | "right", pixels?: number): string {
    return this.exec(`scroll ${direction}${pixels ? ` ${pixels}` : ""}`);
  }

  /** Select a dropdown option */
  select(selector: string, value: string): string {
    return this.exec(`select ${selector} ${value}`);
  }

  /** Hover over an element */
  hover(selector: string): string {
    return this.exec(`hover ${selector}`);
  }

  /** Close the browser */
  close(): string {
    return this.exec("close");
  }

  /** Execute JavaScript in the page context */
  evaluate(code: string): string {
    return this.exec(`evaluate "${code.replace(/"/g, '\\"')}"`);
  }

  /** Wait for a selector to become visible or wait N milliseconds */
  wait(selectorOrMs: string | number): string {
    if (typeof selectorOrMs === "number") {
      return this.exec(`wait ${selectorOrMs}`);
    }
    return this.exec(`wait visible ${selectorOrMs}`);
  }

  /** Get page title */
  getTitle(): string {
    return this.exec("get title");
  }

  /** Get current URL */
  getUrl(): string {
    return this.exec("get url");
  }

  /** Get element text content */
  getText(selector: string): string {
    return this.exec(`get text ${selector}`);
  }

  /** Get element attribute */
  getAttribute(selector: string, attr: string): string {
    return this.exec(`get attr ${selector} ${attr}`);
  }

  /** Navigate back */
  back(): string {
    return this.exec("back");
  }

  /** Navigate forward */
  forward(): string {
    return this.exec("forward");
  }

  /** Reload the page */
  reload(): string {
    return this.exec("reload");
  }

  // ============================================
  // Private helpers
  // ============================================

  private parseSnapshot(raw: string): BrowserSnapshot {
    const elements: BrowserSnapshot["elements"] = [];
    const lines = raw.split("\n");
    let url = "";
    let title = "";

    for (const line of lines) {
      // Parse element refs like: @e1 button "Submit"
      const refMatch = line.match(/^(@e\d+)\s+(\w+)\s+"([^"]*)"(?:\s+value="([^"]*)")?/);
      if (refMatch) {
        elements.push({
          ref: refMatch[1],
          role: refMatch[2],
          name: refMatch[3],
          ...(refMatch[4] !== undefined ? { value: refMatch[4] } : {}),
        });
        continue;
      }
      // Parse URL line
      const urlMatch = line.match(/^URL:\s*(.+)/);
      if (urlMatch) {
        url = urlMatch[1].trim();
        continue;
      }
      // Parse title line
      const titleMatch = line.match(/^Title:\s*(.+)/);
      if (titleMatch) {
        title = titleMatch[1].trim();
        continue;
      }
    }

    // If we could not parse structured data, return raw as title fallback
    if (!title && !url && elements.length === 0) {
      title = raw;
    }

    return { elements, url, title };
  }

  private exec(command: string): string {
    try {
      return execSync(`agent-browser ${command}`, {
        timeout: this.timeout,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch (err: any) {
      return `Error: ${err.stderr || err.message}`;
    }
  }
}

// ============================================
// Tool definitions for AI SDK tool registry
// ============================================

export const browserToolDefinitions = [
  {
    name: "browser_open",
    description: "Open a URL in the browser for web research, testing, or automation",
    schema: { url: { type: "string", description: "URL to navigate to" } },
  },
  {
    name: "browser_snapshot",
    description:
      "Get accessibility snapshot of current page with element refs for interaction",
    schema: {},
  },
  {
    name: "browser_click",
    description: "Click an element by ref (@e1) or CSS selector",
    schema: { selector: { type: "string" } },
  },
  {
    name: "browser_fill",
    description: "Clear and fill an input field",
    schema: { selector: { type: "string" }, text: { type: "string" } },
  },
  {
    name: "browser_type",
    description: "Type text into an element (append mode, does not clear first)",
    schema: { selector: { type: "string" }, text: { type: "string" } },
  },
  {
    name: "browser_screenshot",
    description: "Take a screenshot of the current page",
    schema: {
      path: { type: "string", description: "File path to save screenshot" },
    },
  },
  {
    name: "browser_text",
    description: "Get all text content from the current page",
    schema: {},
  },
  {
    name: "browser_scroll",
    description: "Scroll the page in a given direction",
    schema: {
      direction: {
        type: "string",
        enum: ["up", "down", "left", "right"],
      },
      pixels: { type: "number" },
    },
  },
  {
    name: "browser_close",
    description: "Close the browser session",
    schema: {},
  },
] as const;
