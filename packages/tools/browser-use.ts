/**
 * 8gent Code - Browser Use CLI Wrapper
 *
 * Wraps the browser-use CLI (installed at ~/.pyenv/shims/browser-use)
 * as a TypeScript module for agent tool integration.
 *
 * Supports: open, state, screenshot, click, type, eval, task, scroll, wait, close, sessions
 */

import { execSync } from "node:child_process";

const BROWSER_USE = "browser-use";
const DEFAULT_TIMEOUT = 30_000;

/**
 * Run a browser-use CLI command and return output.
 * Never throws - returns error message string on failure.
 */
function run(args: string[], timeout = DEFAULT_TIMEOUT): string {
	try {
		const result = execSync(
			[BROWSER_USE, ...args]
				.map((a) => {
					// Quote args that contain spaces
					if (a.includes(" ") && !a.startsWith('"') && !a.startsWith("'")) {
						return `"${a.replace(/"/g, '\\"')}"`;
					}
					return a;
				})
				.join(" "),
			{
				timeout,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env },
			},
		);
		return result.trim();
	} catch (err: any) {
		const stderr = err.stderr?.toString().trim();
		const stdout = err.stdout?.toString().trim();
		const msg = stderr || stdout || err.message || "Unknown browser-use error";
		return `browser-use error: ${msg}`;
	}
}

/**
 * Append session flag if provided
 */
function withSession(args: string[], session?: string): string[] {
	if (session) {
		return [...args, "--session", session];
	}
	return args;
}

/**
 * Open a URL in the browser and return page state summary.
 */
export function browserOpen(
	url: string,
	options?: { browser?: string; session?: string },
): string {
	const args = ["open", url, "--json"];
	if (options?.browser) {
		args.push("--browser", options.browser);
	}
	return run(withSession(args, options?.session));
}

/**
 * Get current page state: URL, title, and clickable elements with indices.
 */
export function browserState(session?: string): string {
	return run(withSession(["state", "--json"], session));
}

/**
 * Take a screenshot and return the file path or base64 data.
 */
export function browserScreenshot(filePath?: string, session?: string): string {
	const args = ["screenshot"];
	if (filePath) {
		args.push(filePath);
	}
	return run(withSession(args, session));
}

/**
 * Run a complex browser task with LLM reasoning.
 * For cloud/remote browsers, use options.browser = "remote".
 */
export function browserTask(
	task: string,
	options?: { browser?: string; session?: string },
): string {
	const args = ["task", task, "--json"];
	if (options?.browser) {
		args.push("--browser", options.browser);
	}
	// Tasks can take longer - use 60s timeout
	return run(withSession(args, options?.session), 60_000);
}

/**
 * Click on an element by its index (from browserState output).
 */
export function browserClick(index: number, session?: string): string {
	return run(withSession(["click", String(index), "--json"], session));
}

/**
 * Type text into the currently focused element.
 */
export function browserType(text: string, session?: string): string {
	return run(withSession(["type", text, "--json"], session));
}

/**
 * Evaluate JavaScript in the browser context and return the result.
 */
export function browserEval(js: string, session?: string): string {
	return run(withSession(["eval", js, "--json"], session));
}

/**
 * Scroll the page. Direction can be "up" or "down".
 */
export function browserScroll(
	direction: "up" | "down" = "down",
	session?: string,
): string {
	return run(withSession(["scroll", direction], session));
}

/**
 * Close the browser session.
 */
export function browserClose(session?: string): string {
	return run(withSession(["close"], session));
}

/**
 * List active browser sessions.
 */
export function browserSessions(): string {
	return run(["sessions", "--json"]);
}
