"use client";

import { useCallback, useEffect, useReducer, useState } from "react";
import type { SessionInfo } from "./api/sessions/route";
import SessionList from "./components/SessionList";
import SessionViewer from "./components/SessionViewer";
import SystemHealth from "./components/SystemHealth";

type View = "sessions" | "health";

interface UIState {
	sidebarWidth: number;
	dragging: boolean;
	view: View;
	isDark: boolean;
}

type UIAction =
	| { type: "set-sidebar-width"; value: number }
	| { type: "set-dragging"; value: boolean }
	| { type: "set-view"; value: View }
	| { type: "set-theme"; isDark: boolean };

function uiReducer(state: UIState, action: UIAction): UIState {
	switch (action.type) {
		case "set-sidebar-width":
			return { ...state, sidebarWidth: action.value };
		case "set-dragging":
			return { ...state, dragging: action.value };
		case "set-view":
			return { ...state, view: action.value };
		case "set-theme":
			return { ...state, isDark: action.isDark };
		default:
			return state;
	}
}

const SIDEBAR_MIN = 240;
const SIDEBAR_MAX = 600;
const SIDEBAR_DEFAULT = 360;
const SIDEBAR_KEYBOARD_STEP = 16;

export default function HomeClient({
	initialSessions,
}: {
	initialSessions: SessionInfo[];
}) {
	// Server-rendered seed; client polling mutates this thereafter, so it is genuinely state, not derived.
	// react-doctor-disable-next-line react-doctor/no-derived-useState
	const [sessions, setSessions] = useState<SessionInfo[]>(initialSessions);
	const [active, setActive] = useState<SessionInfo | null>(null);
	const [error, setError] = useState<string | null>(null);

	const [ui, dispatch] = useReducer(uiReducer, {
		sidebarWidth: SIDEBAR_DEFAULT,
		dragging: false,
		view: "sessions",
		isDark: true,
	});

	// Init theme from localStorage on mount.
	useEffect(() => {
		const saved = localStorage.getItem("8gent-debugger-theme");
		if (saved === "light") {
			dispatch({ type: "set-theme", isDark: false });
			document.documentElement.classList.remove("dark");
		} else if (saved === "dark" || document.documentElement.classList.contains("dark")) {
			dispatch({ type: "set-theme", isDark: true });
		} else {
			const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
			dispatch({ type: "set-theme", isDark: dark });
		}
	}, []);

	const toggleTheme = () => {
		const next = !ui.isDark;
		dispatch({ type: "set-theme", isDark: next });
		if (next) {
			document.documentElement.classList.add("dark");
			localStorage.setItem("8gent-debugger-theme", "dark");
		} else {
			document.documentElement.classList.remove("dark");
			localStorage.setItem("8gent-debugger-theme", "light");
		}
	};

	// Read session ID from URL on mount.
	const getSessionIdFromURL = useCallback(() => {
		if (typeof window === "undefined") return null;
		const url = new URL(window.location.href);
		return url.searchParams.get("session");
	}, []);

	// Sync session selection to URL.
	const selectSession = useCallback((s: SessionInfo | null) => {
		setActive(s);
		if (typeof window === "undefined") return;
		const url = new URL(window.location.href);
		if (s) {
			url.searchParams.set("session", s.sessionId);
		} else {
			url.searchParams.delete("session");
		}
		window.history.replaceState({}, "", url.toString());
	}, []);

	// Auto-select session from URL once initial server-rendered list is in.
	useEffect(() => {
		const urlSessionId = getSessionIdFromURL();
		if (urlSessionId) {
			const match = sessions.find((s) => s.sessionId === urlSessionId);
			if (match) setActive(match);
		}
		// run once on mount; sessions ref captured intentionally
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Refresh session list every 10s via filesystem polling.
	// Kept as fetch-in-effect because /api/sessions reads the live ~/.8gent/sessions directory; an RSC
	// would need cache:'no-store' + revalidatePath plumbing for the same effect, with no real win.
	// Two setStates per tick (success + error) is the correct pattern for a polling guard.
	// react-doctor-disable-next-line react-doctor/no-fetch-in-effect
	// react-doctor-disable-next-line react-doctor/no-cascading-set-state
	useEffect(() => {
		const interval = setInterval(() => {
			fetch("/api/sessions")
				.then((r) => r.json())
				.then((data) => {
					if (Array.isArray(data)) setSessions(data);
				})
				.catch((e) => setError(String(e)));
		}, 10000);
		return () => clearInterval(interval);
	}, []);

	// Resizable sidebar (mouse drag).
	useEffect(() => {
		if (!ui.dragging) return;
		const onMove = (e: MouseEvent) => {
			dispatch({
				type: "set-sidebar-width",
				value: Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, e.clientX)),
			});
		};
		const onUp = () => dispatch({ type: "set-dragging", value: false });
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
		return () => {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
		};
	}, [ui.dragging]);

	// Keyboard resize for accessibility (matches the WAI-ARIA "separator" pattern).
	const handleSeparatorKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.key === "ArrowLeft") {
			e.preventDefault();
			dispatch({
				type: "set-sidebar-width",
				value: Math.max(SIDEBAR_MIN, ui.sidebarWidth - SIDEBAR_KEYBOARD_STEP),
			});
		} else if (e.key === "ArrowRight") {
			e.preventDefault();
			dispatch({
				type: "set-sidebar-width",
				value: Math.min(SIDEBAR_MAX, ui.sidebarWidth + SIDEBAR_KEYBOARD_STEP),
			});
		}
	};

	return (
		<div
			className="flex h-screen"
			style={{ background: "var(--background)", color: "var(--foreground)" }}
		>
			{/* Sidebar */}
			<div
				className="flex-shrink-0 flex flex-col"
				style={{
					width: ui.sidebarWidth,
					borderRight: "1px solid var(--border)",
					background: "var(--background)",
				}}
			>
				{/* Logo + View Toggle + Theme */}
				<div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
					<div className="flex items-center gap-2">
						<span className="text-emerald-400 font-mono font-bold text-lg">8gent</span>
						<span style={{ color: "var(--muted)" }} className="text-xs">
							debugger
						</span>
						<button
							type="button"
							onClick={toggleTheme}
							className="ml-auto text-xs px-2 py-0.5 rounded"
							style={{ background: "var(--accent-bg)", color: "var(--accent)" }}
						>
							{ui.isDark ? "☀ Light" : "🌙 Dark"}
						</button>
					</div>
					<div className="flex items-center gap-1 mt-2">
						<button
							type="button"
							onClick={() => dispatch({ type: "set-view", value: "sessions" })}
							className={`text-[10px] px-2 py-1 rounded ${
								ui.view === "sessions" ? "bg-emerald-500/20 text-emerald-400" : ""
							}`}
							style={ui.view !== "sessions" ? { color: "var(--muted)" } : undefined}
						>
							Sessions ({sessions.length})
						</button>
						<button
							type="button"
							onClick={() => dispatch({ type: "set-view", value: "health" })}
							className={`text-[10px] px-2 py-1 rounded ${
								ui.view === "health" ? "bg-cyan-500/20 text-cyan-400" : ""
							}`}
							style={ui.view !== "health" ? { color: "var(--muted)" } : undefined}
						>
							System Health
						</button>
					</div>
				</div>

				{error ? (
					<div className="p-4 text-red-400 text-xs">{error}</div>
				) : (
					<SessionList
						sessions={sessions}
						activeId={active?.sessionId ?? null}
						onSelect={(s) => selectSession(s)}
					/>
				)}
			</div>

			{/* Resize handle: ARIA separator with keyboard support. */}
			<div
				role="separator"
				aria-orientation="vertical"
				aria-valuenow={ui.sidebarWidth}
				aria-valuemin={SIDEBAR_MIN}
				aria-valuemax={SIDEBAR_MAX}
				aria-label="Resize sidebar"
				tabIndex={0}
				className={`w-1 cursor-col-resize hover:bg-emerald-500/30 transition-colors ${
					ui.dragging ? "bg-emerald-500/30" : ""
				}`}
				onMouseDown={() => dispatch({ type: "set-dragging", value: true })}
				onKeyDown={handleSeparatorKey}
			/>

			{/* Main content */}
			<div className="flex-1 min-w-0">
				{ui.view === "health" ? (
					<SystemHealth />
				) : active ? (
					<SessionViewer session={active} />
				) : (
					<div className="flex items-center justify-center h-full">
						<div className="text-center" style={{ color: "var(--muted)" }}>
							<p className="text-4xl mb-4 font-mono">8</p>
							<p className="text-sm">Select a session to inspect</p>
							<p className="text-xs mt-2" style={{ color: "var(--border)" }}>
								Sessions stream live from ~/.8gent/sessions
							</p>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
