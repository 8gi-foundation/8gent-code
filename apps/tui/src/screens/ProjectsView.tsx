/**
 * ProjectsView — Real project switcher that discovers, lists, and switches
 * working directories. Reads from ~/.8gent/tabs/projects.json and scans
 * common directories for projects containing package.json, .git, CLAUDE.md,
 * or .8gent/.
 */

import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import {
	AppText,
	MutedText,
	Heading,
	Stack,
	Inline,
	Divider,
	Badge,
} from "../components/primitives/index.js";
import { execSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProjectEntry {
	path: string;
	name: string;
	gitBranch?: string;
	lastModified?: number;
	has8gent: boolean;
	/** ISO string — when manually added */
	addedAt?: string;
}

interface SavedProject {
	path: string;
	name: string;
	addedAt: string;
}

interface ProjectsFile {
	projects: SavedProject[];
}

export interface ProjectsViewProps {
	visible: boolean;
	onClose: () => void;
	onSwitchProject: (path: string) => void;
	currentPath: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SAVED_PROJECTS_PATH = join(homedir(), ".8gent", "tabs", "projects.json");
const SCAN_DIRS = [
	homedir(),
	join(homedir(), "Documents"),
	join(homedir(), "Projects"),
	join(homedir(), "Code"),
];
const PROJECT_MARKERS = ["package.json", ".git", "CLAUDE.md", ".8gent"];
// Depth-1 scan only — no deep recursion
const MAX_DEPTH = 1;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isProjectDir(dirPath: string): boolean {
	try {
		return PROJECT_MARKERS.some((marker) =>
			existsSync(join(dirPath, marker))
		);
	} catch {
		return false;
	}
}

function getProjectName(dirPath: string): string {
	try {
		const pkgPath = join(dirPath, "package.json");
		if (existsSync(pkgPath)) {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
			if (pkg.name) return pkg.name;
		}
	} catch {
		// fall through
	}
	return basename(dirPath);
}

function getGitBranch(dirPath: string): string | undefined {
	try {
		if (!existsSync(join(dirPath, ".git"))) return undefined;
		const result = execSync(`git -C "${dirPath}" branch --show-current 2>/dev/null`, {
			encoding: "utf8",
			timeout: 2000,
		});
		return result.trim() || undefined;
	} catch {
		return undefined;
	}
}

function getLastModified(dirPath: string): number | undefined {
	try {
		return statSync(dirPath).mtime.getTime();
	} catch {
		return undefined;
	}
}

function has8gent(dirPath: string): boolean {
	return existsSync(join(dirPath, ".8gent"));
}

function buildProjectEntry(dirPath: string): ProjectEntry {
	return {
		path: dirPath,
		name: getProjectName(dirPath),
		gitBranch: getGitBranch(dirPath),
		lastModified: getLastModified(dirPath),
		has8gent: has8gent(dirPath),
	};
}

function scanForProjects(currentPath: string): ProjectEntry[] {
	const found = new Set<string>();
	const results: ProjectEntry[] = [];

	// Always include current path
	found.add(currentPath);
	results.push(buildProjectEntry(currentPath));

	for (const scanDir of SCAN_DIRS) {
		if (!existsSync(scanDir)) continue;
		try {
			const entries = readdirSync(scanDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				if (entry.name.startsWith(".")) continue;
				const fullPath = join(scanDir, entry.name);
				if (found.has(fullPath)) continue;
				if (isProjectDir(fullPath)) {
					found.add(fullPath);
					results.push(buildProjectEntry(fullPath));
				}
			}
		} catch {
			// Permission denied or other error — skip
		}
	}

	// Sort: has8gent first, then by lastModified descending
	results.sort((a, b) => {
		if (a.path === currentPath) return -1;
		if (b.path === currentPath) return 1;
		if (a.has8gent !== b.has8gent) return a.has8gent ? -1 : 1;
		return (b.lastModified ?? 0) - (a.lastModified ?? 0);
	});

	return results;
}

function loadSavedProjects(): SavedProject[] {
	try {
		if (!existsSync(SAVED_PROJECTS_PATH)) return [];
		const raw = readFileSync(SAVED_PROJECTS_PATH, "utf8");
		const data: ProjectsFile = JSON.parse(raw);
		return data.projects ?? [];
	} catch {
		return [];
	}
}

function saveSavedProjects(projects: SavedProject[]): void {
	try {
		const dir = join(homedir(), ".8gent", "tabs");
		mkdirSync(dir, { recursive: true });
		const data: ProjectsFile = { projects };
		writeFileSync(SAVED_PROJECTS_PATH, JSON.stringify(data, null, 2), "utf8");
	} catch {
		// silent — non-critical
	}
}

function mergeProjects(scanned: ProjectEntry[], saved: SavedProject[]): ProjectEntry[] {
	const paths = new Set(scanned.map((p) => p.path));
	const extra: ProjectEntry[] = [];

	for (const s of saved) {
		if (paths.has(s.path)) continue;
		if (!existsSync(s.path)) continue;
		paths.add(s.path);
		extra.push(buildProjectEntry(s.path));
	}

	return [...scanned, ...extra];
}

function formatRelativeTime(ts: number | undefined): string {
	if (!ts) return "unknown";
	const diff = Date.now() - ts;
	const mins = Math.floor(diff / 60000);
	const hours = Math.floor(diff / 3600000);
	const days = Math.floor(diff / 86400000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	if (hours < 24) return `${hours}h ago`;
	if (days < 7) return `${days}d ago`;
	return new Date(ts).toLocaleDateString();
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ProjectsView({
	visible,
	onClose,
	onSwitchProject,
	currentPath,
}: ProjectsViewProps) {
	const [projects, setProjects] = useState<ProjectEntry[]>([]);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [isLoading, setIsLoading] = useState(true);
	const [addMode, setAddMode] = useState(false);
	const [addInput, setAddInput] = useState("");
	const [statusMsg, setStatusMsg] = useState<string | null>(null);

	// ── Load & scan ────────────────────────────────────────────────────────────
	const refresh = useCallback(() => {
		setIsLoading(true);
		setStatusMsg(null);
		// Run async but synchronously inside Bun — keep it simple with a timeout
		setTimeout(() => {
			try {
				const scanned = scanForProjects(currentPath);
				const saved = loadSavedProjects();
				const merged = mergeProjects(scanned, saved);
				setProjects(merged);
				// Reset selection to current project
				const idx = merged.findIndex((p) => p.path === currentPath);
				setSelectedIndex(idx >= 0 ? idx : 0);
			} finally {
				setIsLoading(false);
			}
		}, 0);
	}, [currentPath]);

	useEffect(() => {
		if (visible) refresh();
	}, [visible, refresh]);

	// ── Persistence helpers ────────────────────────────────────────────────────
	const persistProjects = useCallback((list: ProjectEntry[]) => {
		const saved: SavedProject[] = list.map((p) => ({
			path: p.path,
			name: p.name,
			addedAt: p.addedAt ?? new Date().toISOString(),
		}));
		saveSavedProjects(saved);
	}, []);

	// ── Keyboard ───────────────────────────────────────────────────────────────
	useInput(
		(input, key) => {
			if (addMode) {
				if (key.return) {
					const trimmed = addInput.trim();
					if (trimmed && existsSync(trimmed)) {
						const newEntry: ProjectEntry = {
							...buildProjectEntry(trimmed),
							addedAt: new Date().toISOString(),
						};
						const updated = [...projects, newEntry];
						setProjects(updated);
						persistProjects(updated);
						setSelectedIndex(updated.length - 1);
						setStatusMsg(`Added: ${trimmed}`);
					} else {
						setStatusMsg("Path not found — nothing added.");
					}
					setAddMode(false);
					setAddInput("");
				} else if (key.escape) {
					setAddMode(false);
					setAddInput("");
				} else if (key.backspace || key.delete) {
					setAddInput((prev) => prev.slice(0, -1));
				} else if (input && !key.ctrl && !key.meta) {
					setAddInput((prev) => prev + input);
				}
				return;
			}

			if (key.upArrow) {
				setSelectedIndex((prev) => Math.max(0, prev - 1));
			} else if (key.downArrow) {
				setSelectedIndex((prev) => Math.min(projects.length - 1, prev + 1));
			} else if (key.return) {
				const proj = projects[selectedIndex];
				if (proj) {
					onSwitchProject(proj.path);
					onClose();
				}
			} else if (input === "a") {
				setAddMode(true);
				setAddInput("");
				setStatusMsg(null);
			} else if (input === "d") {
				const proj = projects[selectedIndex];
				if (proj && proj.path !== currentPath) {
					const updated = projects.filter((_, i) => i !== selectedIndex);
					setProjects(updated);
					persistProjects(updated);
					setSelectedIndex((prev) => Math.min(prev, updated.length - 1));
					setStatusMsg(`Removed: ${proj.name}`);
				} else {
					setStatusMsg("Cannot remove current project.");
				}
			} else if (input === "r") {
				refresh();
			} else if (key.escape) {
				onClose();
			}
		},
		{ isActive: visible }
	);

	if (!visible) return null;

	// ── Render ─────────────────────────────────────────────────────────────────
	return (
		<Box flexDirection="column" paddingX={1} paddingY={0}>
			{/* Header */}
			<Inline gap={1}>
				<Heading>Projects</Heading>
				{!isLoading && (
					<MutedText>({projects.length} found)</MutedText>
				)}
				{isLoading && <MutedText>scanning...</MutedText>}
			</Inline>

			<MutedText>
				↑↓ Navigate · Enter Switch · a Add · d Remove · r Refresh · Esc Close
			</MutedText>

			<Divider />

			{/* Add mode input */}
			{addMode && (
				<Box marginY={0} borderStyle="round" borderColor="yellow" paddingX={1}>
					<Inline gap={0}>
						<Text color="yellow" bold>
							Add path:{" "}
						</Text>
						<Text color="cyan">{addInput}</Text>
						<Text color="yellow">█</Text>
					</Inline>
				</Box>
			)}

			{/* Status message */}
			{statusMsg && !addMode && (
				<MutedText>{statusMsg}</MutedText>
			)}

			{/* Project list */}
			{isLoading ? (
				<MutedText>Scanning directories…</MutedText>
			) : projects.length === 0 ? (
				<MutedText>No projects found. Press 'a' to add one.</MutedText>
			) : (
				<Stack gap={0}>
					{projects.map((proj, index) => {
						const isSelected = index === selectedIndex;
						const isCurrent = proj.path === currentPath;

						return (
							<Box
								key={proj.path}
								paddingLeft={1}
								paddingY={0}
								borderStyle={isSelected ? "round" : undefined}
								borderColor={isSelected ? "cyan" : undefined}
							>
								<Stack gap={0}>
									{/* Row 1: indicator + name + badges */}
									<Inline gap={1}>
										<Text color="cyan" bold>
											{isSelected ? "›" : " "}
										</Text>
										<AppText bold={isSelected}>
											{proj.name}
										</AppText>
										{isCurrent && (
											<Badge label="HERE" color="green" />
										)}
										{proj.has8gent && (
											<Badge label="8gent" color="magenta" variant="outline" />
										)}
										{proj.gitBranch && (
											<Text color="blue" dimColor>
												 {proj.gitBranch}
											</Text>
										)}
									</Inline>

									{/* Row 2: path + last modified */}
									<Inline gap={1}>
										<Text>{"  "}</Text>
										<MutedText>
											{proj.path}
										</MutedText>
										<MutedText>
											· {formatRelativeTime(proj.lastModified)}
										</MutedText>
									</Inline>
								</Stack>
							</Box>
						);
					})}
				</Stack>
			)}
		</Box>
	);
}

export default ProjectsView;
