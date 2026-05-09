/**
 * DjDeck — premium terminal audio deck.
 * - Timer ticks locally between polls so seconds advance smoothly
 * - Animated pseudo-waveform centered on the artist row when playing
 * - Volume slider updates in real time via Ctrl+Up/Down
 *
 * Stereo behaviour (#2341):
 * - Default = expanded on first run.
 * - User collapses via ^D to a single thin line (track + tiny waveform + play icon).
 * - Never auto-hides, never auto-expands, never collapses to zero height.
 * - Choice persists in workspace DB at app_state(`tui`, `djDeckExpanded`).
 */

import { Box, Text, useInput } from "ink";
import React, { useEffect, useRef, useState } from "react";
import { t } from "../theme.js";

// ── Persistence helpers ───────────────────────────────────────────────
// Lazy + best-effort: never let a DB error crash the deck. If the workspace
// DB is unavailable (e.g. tests, sandboxed CI), we silently fall back to the
// in-memory default (expanded).

const PERSIST_APP_ID = "tui";
const PERSIST_KEY = "djDeckExpanded";

async function loadPersistedExpanded(): Promise<boolean | null> {
	try {
		const mod = await import("../../../../packages/db/src/index.js");
		const db = mod.getWorkspaceDb();
		const value = db.getAppState<boolean>(PERSIST_APP_ID, PERSIST_KEY);
		return typeof value === "boolean" ? value : null;
	} catch {
		return null;
	}
}

async function persistExpanded(value: boolean): Promise<void> {
	try {
		const mod = await import("../../../../packages/db/src/index.js");
		const db = mod.getWorkspaceDb();
		db.setAppState(PERSIST_APP_ID, PERSIST_KEY, value);
	} catch {
		/* best effort */
	}
}

interface DjStatus {
	playing: boolean;
	paused: boolean;
	looping: boolean;
	title: string;
	url: string;
	position: number | null;
	duration: number | null;
	volume: number | null;
	queueSize: number;
}

const EMPTY: DjStatus = {
	playing: false, paused: false, looping: false,
	title: "", url: "", position: null, duration: null, volume: null, queueSize: 0,
};

let setOpenExternal: ((v: boolean) => void) | null = null;
let toggleOpenExternal: (() => void) | null = null;
export function setDjDeckOpen(open: boolean): void {
	setOpenExternal?.(open);
}
export function toggleDjDeckOpen(): void {
	toggleOpenExternal?.();
}

function fmt(s: number | null): string {
	if (s == null || !Number.isFinite(s) || s < 0) return "0:00";
	const m = Math.floor(s / 60);
	const r = Math.floor(s % 60);
	return `${m}:${r.toString().padStart(2, "0")}`;
}

function truncateEnd(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 1))}…`;
}

// Waveform chars — deterministic pseudo-random animation driven by tick
const WAVE = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const WAVE_IDLE = "▁▁▁▁▁▁▁▁▁▁▁▁";

function waveFrame(tick: number, bars = 12): string {
	return Array.from({ length: bars }, (_, i) => {
		const idx = Math.abs((tick * 3 + i * 7 + i * i * 2) % WAVE.length);
		return WAVE[idx];
	}).join("");
}

function VolumeSlider({ volume, muted, width }: { volume: number | null; muted: boolean; width: number }) {
	if (muted) return <Text color={t.textDim}>muted</Text>;
	if (volume == null) return <Text color={t.textDim}>vol --</Text>;
	const pct = Math.min(150, Math.max(0, volume));
	// Slider tracks 0-100 visually; over 100% shows fully filled + label
	const displayPct = Math.min(100, pct);
	const filled = Math.round((displayPct / 100) * width);
	const bar = "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
	return (
		<Box>
			<Text color={t.orange}>{bar}</Text>
			<Text color={t.orangeDim}> {pct}%</Text>
		</Box>
	);
}

export function StereoDisplay(props: {
	playing: boolean;
	track: string;
	artist: string;
	elapsed: string;
	duration: string;
	volume: number | null;
	muted: boolean;
	tick: number;
	termWidth: number;
	hasTrack?: boolean;
}) {
	// hasTrack defaults true for backwards compatibility with prior call sites.
	const hasTrack = props.hasTrack !== false;
	const wave = !hasTrack ? WAVE_IDLE : props.playing ? waveFrame(props.tick) : WAVE_IDLE;
	// Vol slider gets ~40% of available width minus label/padding
	const sliderWidth = Math.max(8, Math.floor(props.termWidth * 0.3));

	const trackText = hasTrack ? props.track : "(no track)";
	const artistText = hasTrack ? props.artist : "";
	const trackColor = hasTrack ? t.textPrimary : t.textDim;
	const artistColor = hasTrack ? t.orange : t.textDim;

	return (
		<Box
			width="100%"
			borderStyle="single"
			borderColor={t.orangeDim}
			paddingX={1}
			flexDirection="column"
		>
			{/* Row 1: track name + clock icon */}
			<Box justifyContent="space-between" width="100%">
				<Box minWidth={0} flexGrow={1}>
					<Text color={t.orange}>{props.playing ? "◴ " : "○ "}</Text>
					<Text color={trackColor} wrap="truncate-end">{trackText}</Text>
				</Box>
				<Text color={t.orange}>{props.playing ? " ◷" : " ○"}</Text>
			</Box>

			{/* Row 2: artist | waveform (centered) | elapsed / duration */}
			<Box justifyContent="space-between" width="100%">
				<Text color={artistColor}>{artistText}</Text>
				<Text color={props.playing && hasTrack ? t.orangeAlt : t.textDim}>{wave}</Text>
				<Text color={t.orangeDim}>{props.elapsed} / {props.duration}</Text>
			</Box>

			{/* Row 3: volume slider — stays visible even with no track */}
			<Box width="100%">
				<VolumeSlider volume={props.volume} muted={props.muted} width={sliderWidth} />
			</Box>
		</Box>
	);
}

/**
 * Single-line stereo strip. Height 1, full width. Stays in chrome so the
 * deck never auto-hides — even when no track is loaded we still render the
 * placeholder strip so the user sees their stereo is on.
 *
 * Layout:  ▶ Track Name (truncate-end)        ▁▂▃▂   ◷
 *          [---------- track region ---------][wave][play]
 */
export function CollapsedDjDeckStrip(props: {
	playing: boolean;
	track: string;
	tick: number;
}) {
	const playIcon = props.playing ? "▶" : "■";
	const wave = props.playing
		? miniWaveFrame(props.tick)
		: "▁▁▁▁";
	const trackLabel = props.track || "8GENT FM idle";
	return (
		<Box width="100%" flexShrink={0} height={1}>
			<Box flexGrow={1} minWidth={0}>
				<Text color={t.orange}>{playIcon} </Text>
				<Text color={t.textPrimary} wrap="truncate-end">
					{trackLabel}
				</Text>
			</Box>
			<Text color={props.playing ? t.orangeAlt : t.textDim}>{wave}</Text>
			<Text color={t.orange}> {props.playing ? "◷" : "○"}</Text>
		</Box>
	);
}

// 4-bar mini waveform for the collapsed strip
function miniWaveFrame(tick: number): string {
	return Array.from({ length: 4 }, (_, i) => {
		const idx = Math.abs((tick * 3 + i * 7 + i * i * 2) % WAVE.length);
		return WAVE[idx];
	}).join("");
}

function ShortcutHintRow({ playing }: { playing: boolean }) {
	return (
		<Box justifyContent="space-between" width="100%" overflow="hidden">
			<Text color={t.muted}>^B prev</Text>
			<Text color={t.muted}>^P {playing ? "pause" : "play"}</Text>
			<Text color={t.muted}>^N next</Text>
			<Text color={t.muted}>^⇧↑↓ vol</Text>
			<Text color={t.muted}>^M mute</Text>
		</Box>
	);
}

function sanitizeTrack(value: string): string {
	return value.replace(/[\u{1F300}-\u{1FAFF}]/gu, "").replace(/\s+/g, " ").trim();
}

// Multiple useState calls model independent slices with different update sources; a reducer would conflate orthogonal events.
// react-doctor-disable-next-line react-doctor/prefer-useReducer
export function DjDeck({ isProcessing = false }: { isProcessing?: boolean } = {}) {
	const [status, setStatus] = useState<DjStatus>(EMPTY);
	// State value is read in render or feeds a derived value used in render — useRef would break visible output.
	// react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers
	const [open, setOpen] = useState(true);
	const [localPos, setLocalPos] = useState<number | null>(null);
	const [tick, setTick] = useState(0);
	// displayVolume: updates immediately for visual feedback; actual dj.volume() is debounced 1s
	const [displayVolume, setDisplayVolume] = useState<number | null>(null);
	const lastVolumeRef = useRef<number>(50);
	const pendingVolumeRef = useRef<number | null>(null);
	const volumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const djRef = useRef<{ instance: any; ready: boolean }>({ instance: null, ready: false });

	useEffect(() => {
		setOpenExternal = setOpen;
		toggleOpenExternal = () => setOpen(prev => !prev);
		return () => {
			setOpenExternal = null;
			toggleOpenExternal = null;
		};
	}, []);

	// Hydrate from workspace DB once on mount. Default = expanded if absent.
	const hydratedRef = useRef(false);
	useEffect(() => {
		(async () => {
			const persisted = await loadPersistedExpanded();
			if (persisted !== null) setOpen(persisted);
			hydratedRef.current = true;
		})();
	}, []);

	// Persist on every toggle, but skip the initial render so we don't write
	// the default value back before hydration completes.
	useEffect(() => {
		if (!hydratedRef.current) return;
		void persistExpanded(open);
	}, [open]);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const mod = await import("../../../../packages/music/dj.js");
				if (cancelled) return;
				djRef.current = { instance: new mod.DJ(), ready: true };
				// Start at 50% volume on open
				try { await djRef.current.instance.volume(50); } catch {}
				setDisplayVolume(50);
			} catch { /* DJ unavailable */ }
		})();
		return () => { cancelled = true; };
	}, []);

	// Poll real status every second
	// react-doctor-disable-next-line react-doctor/no-cascading-set-state
	useEffect(() => {
		const id = setInterval(async () => {
			const dj = djRef.current.instance;
			if (!dj || !djRef.current.ready) return;
			try {
				const s: DjStatus = await dj.status();
				setStatus(s);
				if (s.position != null) setLocalPos(s.position);
				if (s.volume != null && s.volume > 0) {
					lastVolumeRef.current = s.volume;
					// Only sync display volume if not currently scrubbing
					if (pendingVolumeRef.current == null) setDisplayVolume(s.volume);
				}
			} catch { /* keep last known status */ }
		}, 1000);
		return () => clearInterval(id);
	}, []);

	// Local 1-second ticker so time advances between polls
	const playing = status.playing && !status.paused;
	useEffect(() => {
		if (!playing) return;
		const id = setInterval(() => {
			setLocalPos(prev => (prev == null ? null : prev + 1));
		}, 1000);
		return () => clearInterval(id);
	}, [playing]);

	// Waveform animation tick (250ms for smooth animation)
	useEffect(() => {
		if (!playing) return;
		const id = setInterval(() => setTick(v => v + 1), 250);
		return () => clearInterval(id);
	}, [playing]);

	// Adjust display volume immediately; debounce actual dj.volume() by 1s
	const scrubVolume = (delta: number) => {
		const base = displayVolume ?? status.volume ?? 50;
		const next = Math.max(0, Math.min(150, base + delta));
		setDisplayVolume(next);
		pendingVolumeRef.current = next;
		if (lastVolumeRef.current > 0) lastVolumeRef.current = next;
		if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current);
		volumeTimerRef.current = setTimeout(async () => {
			const dj = djRef.current.instance;
			const vol = pendingVolumeRef.current;
			if (!dj || vol == null) return;
			try {
				await dj.volume(vol);
				setStatus(s => ({ ...s, volume: vol }));
			} catch {}
			pendingVolumeRef.current = null;
		}, 1000);
	};

	useInput(
		async (input, key) => {
			if (!key.ctrl) return;
			const dj = djRef.current.instance;
			if (!dj) return;
			const k = (input || "").toLowerCase();
			try {
				if (k === "p") {
					await dj.pause();
				} else if (k === "n") {
					await dj.skip();
				} else if (k === "b") {
					const hist: { title: string; url: string }[] = dj.getHistory?.() ?? [];
					const prev = hist[hist.length - 2];
					if (prev?.url) await dj.play(prev.url);
				} else if (k === "m") {
					const cur = displayVolume ?? status.volume ?? 50;
					if (cur > 0) {
						lastVolumeRef.current = cur;
						setDisplayVolume(0);
						await dj.volume(0);
					} else {
						const restore = lastVolumeRef.current || 50;
						setDisplayVolume(restore);
						await dj.volume(restore);
					}
				} else if (key.shift && key.upArrow) {
					// Shift+Ctrl+Up: volume +1% with 1s debounced send
					scrubVolume(1);
				} else if (key.shift && key.downArrow) {
					// Shift+Ctrl+Down: volume -1% with 1s debounced send
					scrubVolume(-1);
				}
			} catch { /* never crash the TUI */ }
		},
		{ isActive: status.playing || status.title.length > 0 },
	);

	const effectiveVolume = displayVolume ?? status.volume;
	const muted = effectiveVolume != null && effectiveVolume === 0;
	const volume = effectiveVolume == null ? null : Math.round(effectiveVolume);
	// Distinguish "no track ever loaded" from "track loaded / loading a real track".
	// A track exists when status.title is non-empty OR audio is actively playing.
	const hasTrack = status.title.length > 0 || status.playing;
	const track = hasTrack
		? truncateEnd(sanitizeTrack(status.title || "(loading)"), 82)
		: "";

	// Always-on stereo: collapsed mode renders a one-line strip, never zero
	// height. Auto-toggling is forbidden — only ^D / setDjDeckOpen flip this.
	if (!open) {
		const stripTrack = status.title
			? sanitizeTrack(status.title)
			: "";
		return <CollapsedDjDeckStrip playing={playing} track={stripTrack} tick={tick} />;
	}

	// Idle heartbeat: the full deck only appears when audio is ACTIVELY playing.
	// Loading / paused / no-track all collapse to a one-line strip — five rows
	// of stereo chrome for a track that isn't playing was eating the viewport.
	if (!status.playing) {
		// When the agent is mid-turn but no music is playing, show "agent pulse"
		// so the bottom heartbeat reflects the active turn instead of looking dead.
		const idleLabel = status.title
			? "loading"
			: isProcessing
				? "agent pulse"
				: "idle";
		const idleColor = isProcessing ? t.teal : t.dim;
		return (
			<Box
				width="100%"
				borderStyle="round"
				borderColor={t.orangeDim}
				paddingX={1}
				justifyContent="space-between"
				flexShrink={0}
			>
				<Text color={t.orange}>● 8GENT FM</Text>
				<Text color={idleColor}>{idleLabel}</Text>
				<Text color={t.muted}>/dj open</Text>
			</Box>
		);
	}

	return (
		<Box
			width="100%"
			borderStyle="round"
			borderColor={t.orangeDim}
			paddingX={1}
			flexDirection="column"
			flexShrink={0}
		>
			<Box justifyContent="space-between" width="100%">
				<Text color={t.orange}>● 8GENT FM</Text>
				<Text color={t.muted}>/dj close</Text>
			</Box>

			<Box marginTop={1}>
				<StereoDisplay
					playing={playing}
					track={track}
					artist={hasTrack ? "Instrumental" : ""}
					elapsed={hasTrack ? fmt(localPos) : "0:00"}
					duration={hasTrack ? fmt(status.duration) : "0:00"}
					volume={volume}
					muted={muted}
					tick={tick}
					termWidth={80}
					hasTrack={hasTrack}
				/>
			</Box>

			<Box marginTop={1}>
				<ShortcutHintRow playing={playing} />
			</Box>
		</Box>
	);
}
