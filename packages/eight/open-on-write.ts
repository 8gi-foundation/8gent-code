/**
 * Which written files write_file puts in front of the user (#3107).
 *
 * write_file used to run macOS `open` on every file it wrote: source files,
 * config files, and writes from spawned sub-agents. A llama3.2:3b sub-agent
 * wrote src/clamp.ts 7 times in one pilot run and each write popped an editor
 * window. Finished deliverables are still opened; nothing else is.
 *
 * decideOpenOnWrite is pure. openWrittenFile is the one side effect, and
 * tests replace it with setFileOpener.
 */

import * as path from "node:path";

/** Viewable deliverables: what a person opens to look at, not to edit. */
export const OPENABLE_EXTENSIONS = new Set<string>([
	".html",
	".htm",
	".pdf",
	".png",
	".jpg",
	".jpeg",
	".gif",
	".svg",
	".mp4",
	".mov",
	".pptx",
	".docx",
]);

/**
 * A markdown file is opened only when it is clearly a document, not source:
 * a Marp deck (front matter with `marp: true`). README.md, notes, specs and
 * every other .md file stay closed.
 */
export function isDocumentMarkdown(content: string): boolean {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	return m !== null && /^\s*marp\s*:\s*true\s*$/m.test(m[1]);
}

export interface OpenOnWriteInput {
	/** Absolute path of the file just written. */
	absolutePath: string;
	/** What was written (read only for .md). */
	content: string;
	platform: NodeJS.Platform;
	/** false for an agent spawned by the agent pool. */
	openOnWrite: boolean;
	/** stdout is a TTY: a person is at this terminal. */
	isTTY: boolean;
	env: Record<string, string | undefined>;
	/** Paths already opened in this turn. */
	openedThisTurn: ReadonlySet<string>;
}

/** Whether to open this file, and why not when it is not opened. Pure. */
export function decideOpenOnWrite(input: OpenOnWriteInput): { open: boolean; reason: string } {
	if (input.platform !== "darwin") return { open: false, reason: "not macOS" };
	if (input.env.EIGHT_NO_OPEN === "1") return { open: false, reason: "EIGHT_NO_OPEN=1" };
	if (!input.isTTY) return { open: false, reason: "not interactive (no TTY)" };
	if (!input.openOnWrite) return { open: false, reason: "spawned sub-agent" };
	const ext = path.extname(input.absolutePath).toLowerCase();
	const deliverable = OPENABLE_EXTENSIONS.has(ext) || (ext === ".md" && isDocumentMarkdown(input.content));
	if (!deliverable) return { open: false, reason: "not a viewable deliverable" };
	if (input.openedThisTurn.has(input.absolutePath)) return { open: false, reason: "already opened this turn" };
	return { open: true, reason: "deliverable" };
}

type Opener = (absolutePath: string) => void;

const defaultOpener: Opener = (absolutePath) => {
	const { spawn } = require("node:child_process") as typeof import("node:child_process");
	spawn("open", [absolutePath], { detached: true, stdio: "ignore" }).unref();
};

let opener: Opener = defaultOpener;

/** Test hook: replace the opener; call with no argument to restore it. */
export function setFileOpener(fn?: Opener): void {
	opener = fn ?? defaultOpener;
}

/** Open the file. Returns true only when the open was actually started. */
export function openWrittenFile(absolutePath: string): boolean {
	try {
		opener(absolutePath);
		return true;
	} catch {
		return false;
	}
}
