/**
 * SessionTree - the /tree navigator over one session's JSONL tree.
 *
 * Input is SessionStore.tree() and the store's leafId; Enter hands the chosen
 * entry id back to the caller, which calls store.branch(id) (optionally with
 * a branch summary). Nothing here reads or writes the disk; app.tsx wires it.
 *
 * Rows: one per entry, oldest first. A straight run of replies stays at one
 * indent; every fork point indents its branches by one step. Entries on the
 * current path are marked ●, other branches ○, the current leaf ◆.
 *
 * Keys: Up/Down move, Enter continue from here, Ctrl+U user messages only,
 * Esc close.
 */

import { Box, Text, useInput } from "ink";
import type React from "react";
import { useMemo, useState } from "react";
import type { TreeEntry, TreeNode } from "../../../../packages/eight/session-store.js";
import { t } from "../theme.js";
import { KeyCapRow } from "./KeyCap.js";

export interface TreeRow {
	id: string;
	depth: number;
	kind: TreeEntry["type"];
	role: string;
	preview: string;
	onPath: boolean;
	isLeaf: boolean;
	/** This entry starts a branch (its parent has more than one child). */
	branchStart: boolean;
}

function previewOf(entry: TreeEntry): { role: string; preview: string } {
	if (entry.type === "compaction") return { role: "compaction", preview: entry.summary };
	if (entry.type === "branch_summary") return { role: "branch summary", preview: entry.summary };
	const c = entry.message.content;
	const text =
		typeof c === "string"
			? c
			: Array.isArray(c)
				? c
						.map((p) =>
							p && typeof p === "object" && "text" in p
								? String((p as { text: unknown }).text)
								: "",
						)
						.join(" ")
				: "";
	return { role: entry.message.role, preview: text };
}

/**
 * Flatten the tree into display rows. Iterative (sessions can be thousands of
 * entries deep in one chain, which would overflow a recursive walk).
 */
export function flattenTree(roots: TreeNode[], leafId: string | null): TreeRow[] {
	const byId = new Map<string, TreeNode>();
	const walk: TreeNode[] = [...roots];
	while (walk.length) {
		const n = walk.pop() as TreeNode;
		byId.set(n.entry.id, n);
		walk.push(...n.children);
	}
	const onPath = new Set<string>();
	for (let cur = leafId; cur; ) {
		const n = byId.get(cur);
		if (!n) break;
		onPath.add(cur);
		cur = n.entry.parentId;
	}

	const rows: TreeRow[] = [];
	const multiRoot = roots.length > 1;
	const stack: Array<{ node: TreeNode; depth: number; branchStart: boolean }> = [];
	for (let i = roots.length - 1; i >= 0; i--) {
		stack.push({ node: roots[i], depth: multiRoot ? 1 : 0, branchStart: multiRoot });
	}
	while (stack.length) {
		const { node, depth, branchStart } = stack.pop() as (typeof stack)[number];
		const { role, preview } = previewOf(node.entry);
		rows.push({
			id: node.entry.id,
			depth,
			kind: node.entry.type,
			role,
			preview: preview.replace(/\s+/g, " ").trim(),
			onPath: onPath.has(node.entry.id),
			isLeaf: node.entry.id === leafId,
			branchStart,
		});
		const kids = node.children;
		const fork = kids.length > 1;
		for (let i = kids.length - 1; i >= 0; i--) {
			stack.push({ node: kids[i], depth: fork ? depth + 1 : depth, branchStart: fork });
		}
	}
	return rows;
}

export function filterRows(rows: TreeRow[], userOnly: boolean): TreeRow[] {
	return userOnly ? rows.filter((r) => r.kind !== "message" || r.role === "user") : rows;
}

export interface SessionTreeProps {
	isOpen: boolean;
	tree: TreeNode[];
	leafId: string | null;
	/** Continue the conversation from this entry. */
	onSelect: (entryId: string) => void;
	onClose: () => void;
}

export function SessionTree(props: SessionTreeProps): React.ReactElement | null {
	const [userOnly, setUserOnly] = useState(false);
	const all = useMemo(() => flattenTree(props.tree, props.leafId), [props.tree, props.leafId]);
	const rows = useMemo(() => filterRows(all, userOnly), [all, userOnly]);
	const leafIndex = Math.max(
		0,
		rows.findIndex((r) => r.isLeaf),
	);
	const [cursor, setCursor] = useState<number | null>(null);
	const active = Math.min(cursor ?? leafIndex, Math.max(0, rows.length - 1));

	useInput(
		(input, key) => {
			if (key.escape) return props.onClose();
			if (key.upArrow) return setCursor(Math.max(0, active - 1));
			if (key.downArrow) return setCursor(Math.min(rows.length - 1, active + 1));
			if (key.ctrl && input === "u") {
				setCursor(null);
				return setUserOnly((v) => !v);
			}
			if (key.return && rows[active]) {
				props.onClose();
				props.onSelect(rows[active].id);
			}
		},
		{ isActive: props.isOpen },
	);

	if (!props.isOpen) return null;
	return <SessionTreeView rows={rows} active={active} userOnly={userOnly} />;
}

const WIDTH = 76;
const VISIBLE_ROWS = 14;

export function SessionTreeView({
	rows,
	active,
	userOnly,
}: {
	rows: TreeRow[];
	active: number;
	userOnly: boolean;
}): React.ReactElement {
	const half = Math.floor(VISIBLE_ROWS / 2);
	const start = Math.max(0, Math.min(active - half, rows.length - VISIBLE_ROWS));
	const shown = rows.slice(start, start + VISIBLE_ROWS);
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={t.orange}
			paddingX={1}
			width={WIDTH}
			flexShrink={0}
		>
			<Box>
				<Text color={t.orange} bold>
					SESSION TREE
				</Text>
				<Text color={t.textTertiary}>{userOnly ? " user messages only" : " all entries"}</Text>
			</Box>
			{start > 0 ? <Text color={t.textTertiary}> ↑ {start} more</Text> : null}
			{shown.length === 0 ? <Text color={t.textTertiary}>empty session</Text> : null}
			{shown.map((r, i) => {
				const isActive = start + i === active;
				const mark = r.isLeaf ? "◆" : r.onPath ? "●" : "○";
				const indent = "  ".repeat(r.depth);
				const tag = r.kind === "message" ? r.role : r.kind === "compaction" ? "summary" : "branch";
				return (
					<Box key={r.id}>
						<Text color={t.textTertiary}>
							{indent}
							{r.branchStart ? "├ " : "  "}
						</Text>
						<Text color={r.onPath ? t.orange : t.textTertiary}>{mark} </Text>
						<Text color={isActive ? t.orange : t.textSecondary} bold={isActive}>
							{tag.padEnd(10)}
						</Text>
						<Text
							color={isActive ? t.cream : r.onPath ? t.textPrimary : t.textTertiary}
							wrap="truncate-end"
						>
							{r.preview || "(empty)"}
						</Text>
					</Box>
				);
			})}
			{start + VISIBLE_ROWS < rows.length ? (
				<Text color={t.textTertiary}> ↓ {rows.length - start - VISIBLE_ROWS} more</Text>
			) : null}
			<Box>
				<KeyCapRow
					caps={[
						{ cap: "↑↓", verb: "move" },
						{ cap: "Enter", verb: "continue here" },
						{ cap: "^U", verb: "user only" },
						{ cap: "Esc", verb: "close" },
					]}
					idPrefix="session-tree"
					z={20}
				/>
			</Box>
		</Box>
	);
}
