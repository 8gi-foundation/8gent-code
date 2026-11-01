/**
 * Tree perception: accessibility tree as the cheap-perception default.
 *
 * The cua loop calls `perceiveTree()` first on every step. If the tree is
 * sufficient (most window-chrome navigation, menu clicks, button presses,
 * text-field interactions), the loop never burns image tokens. Pixels
 * are only escalated for canvases, image-heavy UIs, and ambiguous element
 * layouts where the tree can not name what the agent needs to click.
 *
 * The tree comes from the daemon side (`desktop_accessibility_tree`),
 * which is backed by the AppKit AX implementation in
 * `packages/daemon/tools/accessibility-tree.ts` (issue #1882).
 */

import { type HandsToolCtx, executeHandsTool } from "../../daemon/tools/hands";

/** Per-perception token-cost record for the loop's budget meter. */
export interface TokenCost {
	method: "tree" | "screenshot" | "skipped";
	tokens: number;
	note?: string;
}

/** Single AX node returned by the daemon. */
export interface AxNode {
	role: string;
	title?: string;
	value?: string;
	position?: { x: number; y: number };
	size?: { width: number; height: number };
	enabled?: boolean;
	focused?: boolean;
	children?: AxNode[];
	/** Convenience hint set by the daemon for clickable affordances. */
	clickable?: boolean;
}

export interface TreePerception {
	kind: "tree";
	ok: boolean;
	pid?: number;
	appName?: string;
	windowTitle?: string;
	root?: AxNode;
	cost: TokenCost;
	error?: string;
}

/**
 * Estimate token cost of a tree by serialising it. The cua loop logs this
 * so the orchestrator can decide whether to switch to screenshot perception
 * on the next step (e.g. tree exceeded N tokens but agent still failed).
 */
function estimateTreeCost(root: AxNode | undefined): TokenCost {
	if (!root) return { method: "tree", tokens: 0, note: "empty tree" };
	const serialized = JSON.stringify(root);
	// Rough heuristic: ~4 chars per token for JSON content. This is a budget
	// signal, not a billing receipt.
	const tokens = Math.ceil(serialized.length / 4);
	return { method: "tree", tokens, note: `~${serialized.length} chars` };
}

export type HandsCallable = (
	toolName: string,
	args: Record<string, unknown>,
	ctx: HandsToolCtx,
) => Promise<{ ok: true; result: unknown } | { ok: false; reason: string }>;

export interface PerceiveTreeInput {
	ctx: HandsToolCtx;
	/** Restrict to a single PID. Default: focused window. */
	pid?: number;
	/** Hard cap on serialized tree size before truncation. */
	maxBytes?: number;
	/** Optional override (CI / smoke). Defaults to the real hands executor. */
	hands?: HandsCallable;
}

export async function perceiveTree(
	input: PerceiveTreeInput,
): Promise<TreePerception> {
	const { ctx, pid, maxBytes = 60_000, hands = executeHandsTool } = input;
	const args: Record<string, unknown> = {};
	if (pid !== undefined) args.pid = pid;

	const result = await hands("desktop_accessibility_tree", args, ctx);
	if (!result.ok) {
		return {
			kind: "tree",
			ok: false,
			cost: { method: "tree", tokens: 0 },
			error: result.reason,
		};
	}

	type RawTreeOk = {
		ok: true;
		pid?: number;
		appName?: string;
		windowTitle?: string;
		root: AxNode;
	};
	type RawTreeErr = { ok?: false; error?: string };
	const data = result.result as RawTreeOk | RawTreeErr;

	if (!data || (data as RawTreeErr).ok === false || !("root" in data)) {
		return {
			kind: "tree",
			ok: false,
			cost: { method: "tree", tokens: 0 },
			error: (data as RawTreeErr | undefined)?.error ?? "tree unavailable",
		};
	}

	const ok = data as RawTreeOk;
	const root = pruneOversizedTree(ok.root, maxBytes);
	return {
		kind: "tree",
		ok: true,
		pid: ok.pid,
		appName: ok.appName,
		windowTitle: ok.windowTitle,
		root,
		cost: estimateTreeCost(root),
	};
}

/** Truncate a tree if its serialized size exceeds the cap. */
function pruneOversizedTree(root: AxNode, maxBytes: number): AxNode {
	const serialized = JSON.stringify(root);
	if (serialized.length <= maxBytes) return root;
	// Strategy: keep the root and one level of children, drop deep grandchildren.
	return {
		...root,
		children: (root.children ?? []).map((child) => ({
			role: child.role,
			title: child.title,
			value: child.value,
			position: child.position,
			size: child.size,
			enabled: child.enabled,
			focused: child.focused,
			clickable: child.clickable,
			children: child.children?.length
				? [
						{
							role: "_truncated",
							title: `${child.children.length} grandchildren omitted`,
						},
					]
				: undefined,
		})),
	};
}

// ---------------------------------------------------------------------------
// Tree query helpers (by-role, by-title, clickable).
// These are pure functions so they can be unit-tested without the daemon.
// ---------------------------------------------------------------------------

export function findByRole(root: AxNode | undefined, role: string): AxNode[] {
	if (!root) return [];
	const out: AxNode[] = [];
	const wantedRole = role.toLowerCase();
	walk(root, (n) => {
		if (n.role && n.role.toLowerCase() === wantedRole) out.push(n);
	});
	return out;
}

export function findByTitle(
	root: AxNode | undefined,
	title: string,
	options: { exact?: boolean } = {},
): AxNode[] {
	if (!root) return [];
	const out: AxNode[] = [];
	const needle = title.toLowerCase();
	walk(root, (n) => {
		if (!n.title) return;
		const t = n.title.toLowerCase();
		if (options.exact ? t === needle : t.includes(needle)) out.push(n);
	});
	return out;
}

export function findClickable(root: AxNode | undefined): AxNode[] {
	if (!root) return [];
	const clickRoles = new Set([
		"button",
		"link",
		"menuitem",
		"menubutton",
		"checkbox",
		"radio",
		"tab",
		"popupbutton",
	]);
	const out: AxNode[] = [];
	walk(root, (n) => {
		if (n.clickable === true) {
			out.push(n);
			return;
		}
		if (n.role && clickRoles.has(n.role.toLowerCase())) out.push(n);
	});
	return out;
}

/** Depth-first walk visiting every node. */
function walk(node: AxNode, visit: (n: AxNode) => void): void {
	visit(node);
	for (const child of node.children ?? []) walk(child, visit);
}

/**
 * Return a compact summary suitable for inclusion in the model's context.
 * Drops cost-heavy fields (positions, sizes, deep children) and keeps the
 * roles + titles + value snippets that drive most decisions.
 */
export function summarizeTree(root: AxNode | undefined, maxNodes = 80): string {
	if (!root) return "(empty)";
	const lines: string[] = [];
	let count = 0;
	function visit(n: AxNode, depth: number): void {
		if (count >= maxNodes) return;
		count += 1;
		const indent = "  ".repeat(depth);
		const title = n.title ? ` "${n.title}"` : "";
		const value = n.value ? ` =${JSON.stringify(n.value).slice(0, 40)}` : "";
		const focus = n.focused ? " [focused]" : "";
		lines.push(`${indent}${n.role}${title}${value}${focus}`);
		for (const child of n.children ?? []) visit(child, depth + 1);
	}
	visit(root, 0);
	if (count >= maxNodes) lines.push(`(... truncated at ${maxNodes} nodes)`);
	return lines.join("\n");
}
