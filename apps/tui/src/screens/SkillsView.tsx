/**
 * 8gent Code - Skills View
 *
 * Browsable menu of every loaded skill. Skills come from the same SkillManager
 * that expands `/<name>` in chat, so the list is exactly what the slash path
 * can run. Enter hands `/<name>` back to the app, which submits it through the
 * normal chat path (handleSubmit -> expandSkillSlashCommand).
 *
 * Mirrors the SettingsView "tab takeover" shape: header with source, two
 * columns, footer key hints, `?` help overlay, `q`/Esc close.
 */

import * as os from "node:os";
import * as path from "node:path";
import { Box, Text, useInput } from "ink";
import React, { useEffect, useMemo, useState } from "react";
// Cross-workspace import of a package's public entrypoint (packages/*/index.ts).
// These are the canonical surface for inter-package use; deep imports would
// bypass each package's documented API. Suppressed by design.
// react-doctor-disable-next-line react-doctor/no-barrel-import
import { getSkillManager, type SkillManager } from "../../../../packages/skills/index.js";
import { AppText, Heading, MutedText } from "../components/primitives/AppText.js";
import { Divider } from "../components/primitives/Divider.js";
import { text as textColor } from "../theme/semantic.js";

export interface SkillRow {
	name: string;
	description: string;
	/** Absolute path of the markdown file the skill was loaded from. */
	filePath: string;
	/** Which root the file lives under (derived from filePath, nothing hardcoded). */
	origin: string;
}

export const EMPTY_STATE_TEXT =
	"No skills loaded. Add .md under ~/.8gent/skills/ or run from a repo with .claude/skills/*/SKILL.md.";

/** Replace the home prefix with ~ so long paths fit a terminal row. */
export function shortenPath(filePath: string, home: string = os.homedir()): string {
	if (home && filePath.startsWith(home)) return `~${filePath.slice(home.length)}`;
	return filePath;
}

/** Name the root a skill file came from. Falls back to its parent directory. */
export function describeOrigin(filePath: string, home: string = os.homedir()): string {
	const claudeIdx = filePath.indexOf(`${path.sep}.claude${path.sep}skills${path.sep}`);
	if (claudeIdx >= 0) return shortenPath(filePath.slice(0, claudeIdx), home) || ".";
	if (filePath.startsWith(path.join(home, ".8gent", "skills"))) return "~/.8gent/skills";
	if (filePath.startsWith(path.join(home, ".8gent", "learned-skills"))) {
		return "~/.8gent/learned-skills";
	}
	return shortenPath(path.dirname(filePath), home);
}

/** Load every skill the slash path can run, sorted by name. */
export async function loadSkillRows(manager: SkillManager = getSkillManager()): Promise<SkillRow[]> {
	await manager.loadSkills();
	return manager
		.getAllSkills()
		.map((s) => ({
			name: s.name,
			description: s.description || "",
			filePath: s.filePath,
			origin: describeOrigin(s.filePath),
		}))
		.toSorted((a, b) => a.name.localeCompare(b.name));
}

/** Case-insensitive match on name, description and origin. Empty query keeps all. */
export function filterSkillRows(rows: SkillRow[], query: string): SkillRow[] {
	const q = query.trim().toLowerCase();
	if (!q) return rows;
	return rows.filter((r) =>
		[r.name, r.description, r.origin].some((v) => v.toLowerCase().includes(q)),
	);
}

/** First index of the visible window so the selected row stays on screen. */
export function computeWindowStart(total: number, selected: number, size: number): number {
	if (total <= size) return 0;
	return Math.max(0, Math.min(selected - Math.floor(size / 2), total - size));
}

export interface SkillsBodyProps {
	rows: SkillRow[];
	filtered: SkillRow[];
	loaded: boolean;
	selectedIndex: number;
	query: string;
	filtering: boolean;
	showHelp: boolean;
	windowSize: number;
}

export function SkillsHelp() {
	return (
		<Box flexDirection="column" paddingX={1}>
			<Box marginBottom={1}>
				<Heading>Skills - Help</Heading>
			</Box>
			<Divider />
			<Box flexDirection="column" paddingY={1}>
				<AppText>Up/Down Move between skills</AppText>
				<AppText>/ Filter by name, description or origin as you type</AppText>
				<AppText>Enter Run the selected skill, the same as typing /name in chat</AppText>
				<AppText>Backspace Erase the filter (clears it entirely when not typing)</AppText>
				<AppText>Esc / q Close the view and return to chat</AppText>
				<AppText>? Show this help</AppText>
			</Box>
			<Divider />
			<MutedText>Press ? or q to dismiss</MutedText>
		</Box>
	);
}

/** Hook-free body so tests can walk the element tree. */
export function SkillsBody(props: SkillsBodyProps) {
	const { rows, filtered, loaded, selectedIndex, query, filtering, showHelp, windowSize } = props;
	if (showHelp) return <SkillsHelp />;

	const selected = filtered[selectedIndex];
	const start = computeWindowStart(filtered.length, selectedIndex, windowSize);
	const visible = filtered.slice(start, start + windowSize);
	const hiddenBelow = Math.max(0, filtered.length - (start + windowSize));
	const listStatus = !loaded
		? "Loading skills"
		: rows.length === 0
			? EMPTY_STATE_TEXT
			: filtered.length === 0
				? `No skill matches "${query}". Backspace clears the filter.`
				: null;

	return (
		<Box flexDirection="column" paddingX={1}>
			<Box marginBottom={1}>
				<Heading>Skills</Heading>
				<MutedText>
					{"  "}~/.8gent/skills and .claude/skills - {rows.length} loaded
					{query ? `, ${filtered.length} match "${query}"` : ""}
				</MutedText>
			</Box>
			<Divider />
			<Box flexDirection="row" paddingY={1}>
				<Box flexDirection="column" width={30} marginRight={2}>
					<Text bold color={textColor.warning}>
						{filtering ? `/${query}_` : query ? `/${query}` : "Loaded skills"}
					</Text>
					<Box marginTop={1} flexDirection="column">
						{listStatus ? <MutedText>{listStatus}</MutedText> : null}
						{start > 0 ? <MutedText>{start} more above</MutedText> : null}
						{visible.map((r, i) => {
							const isSelected = start + i === selectedIndex;
							return (
								<Box key={r.filePath}>
									<Text color={isSelected ? textColor.warning : undefined}>
										{isSelected ? ">" : " "}{" "}
									</Text>
									<AppText bold={isSelected}>{r.name}</AppText>
								</Box>
							);
						})}
						{hiddenBelow > 0 ? <MutedText>{hiddenBelow} more below</MutedText> : null}
					</Box>
				</Box>
				<Box flexDirection="column" flexGrow={1}>
					<Text bold color={textColor.warning}>
						{selected ? `/${selected.name}` : ""}
					</Text>
					{selected ? (
						<Box marginTop={1} flexDirection="column">
							<Box>
								<MutedText>From{"    "}</MutedText>
								<Text color={textColor.accent}>{selected.origin}</Text>
							</Box>
							<Box>
								<MutedText>File{"    "}</MutedText>
								<AppText>{shortenPath(selected.filePath)}</AppText>
							</Box>
							<Box marginTop={1}>
								<AppText wrap="wrap">{selected.description || "No description in the file."}</AppText>
							</Box>
						</Box>
					) : null}
				</Box>
			</Box>
			<Divider />
			{filtering ? (
				<MutedText>Filtering - type to narrow, Backspace to erase, Enter to keep</MutedText>
			) : (
				<MutedText>
					arrows=navigate enter=run /=filter ?=help q=close
					{selected ? ` - selected: /${selected.name}` : ""}
				</MutedText>
			)}
		</Box>
	);
}

interface SkillsViewProps {
	visible: boolean;
	onClose: () => void;
	/** Receives the slash line to submit, e.g. "/boardroom". */
	onRun: (slashLine: string) => void;
	windowSize?: number;
}

export function SkillsView({ visible, onClose, onRun, windowSize = 14 }: SkillsViewProps) {
	const [rows, setRows] = useState<SkillRow[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [query, setQuery] = useState("");
	const [filtering, setFiltering] = useState(false);
	// State value is read in render or feeds a derived value used in render.
	// react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers
	const [showHelp, setShowHelp] = useState(false);

	useEffect(() => {
		let cancelled = false;
		loadSkillRows()
			.then((list) => {
				if (cancelled) return;
				setRows(list);
				setLoaded(true);
			})
			.catch(() => {
				if (!cancelled) setLoaded(true);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const filtered = useMemo(() => filterSkillRows(rows, query), [rows, query]);

	useEffect(() => {
		if (selectedIndex >= filtered.length) setSelectedIndex(Math.max(0, filtered.length - 1));
	}, [filtered.length, selectedIndex]);

	const moveUp = () => setSelectedIndex((prev) => Math.max(0, prev - 1));
	const moveDown = () =>
		setSelectedIndex((prev) => Math.min(Math.max(0, filtered.length - 1), prev + 1));

	useInput(
		(input, key) => {
			if (showHelp) {
				if (input === "?" || key.escape || input === "q") setShowHelp(false);
				return;
			}
			// Esc always closes: the app-level handler switches any non-chat tab
			// back to chat on Esc, so the view must not overload it.
			if (key.escape) {
				onClose();
				return;
			}
			if (filtering) {
				if (key.return) setFiltering(false);
				else if (key.backspace || key.delete) setQuery((prev) => prev.slice(0, -1));
				else if (key.upArrow) moveUp();
				else if (key.downArrow) moveDown();
				else if (input && !key.ctrl && !key.meta) setQuery((prev) => prev + input);
				return;
			}
			if (input === "?") setShowHelp(true);
			else if (input === "/") setFiltering(true);
			else if (input === "q") onClose();
			else if ((key.backspace || key.delete) && query) setQuery("");
			else if (key.upArrow) moveUp();
			else if (key.downArrow) moveDown();
			else if (key.return) {
				const selected = filtered[selectedIndex];
				if (selected) onRun(`/${selected.name}`);
			}
		},
		{ isActive: visible },
	);

	if (!visible) return null;

	return (
		<SkillsBody
			rows={rows}
			filtered={filtered}
			loaded={loaded}
			selectedIndex={selectedIndex}
			query={query}
			filtering={filtering}
			showHelp={showHelp}
			windowSize={windowSize}
		/>
	);
}
