/**
 * DjDeck — premium terminal audio deck.
 * - Timer ticks locally between polls so seconds advance smoothly
 * - Animated pseudo-waveform centered on the artist row when playing
 * - Volume slider updates in real time via Ctrl+Up/Down
 */

import { Box, Text, useInput } from "ink";
import React, { useEffect, useRef, useState } from "react";
import { t } from "../theme.js";

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
export function setDjDeckOpen(open: boolean): void {
	setOpenExternal?.(open);
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

function StereoDisplay(props: {
	playing: boolean;
	track: string;
	artist: string;
	elapsed: string;
	duration: string;
	volume: number | null;
	muted: boolean;
	tick: number;
	termWidth: number;
}) {
	const wave = props.playing ? waveFrame(props.tick) : WAVE_IDLE;
	// Vol slider gets ~40% of available width minus label/padding
	const sliderWidth = Math.max(8, Math.floor(props.termWidth * 0.3));

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
					<Text color={t.textPrimary} wrap="truncate-end">{props.track}</Text>
				</Box>
				<Text color={t.orange}>{props.playing ? " ◷" : " ○"}</Text>
			</Box>

			{/* Row 2: artist | waveform (centered) | elapsed / duration */}
			<Box justifyContent="space-between" width="100%">
				<Text color={t.orange}>{props.artist}</Text>
				<Text color={props.playing ? t.orangeAlt : t.textDim}>{wave}</Text>
				<Text color={t.orangeDim}>{props.elapsed} / {props.duration}</Text>
			</Box>

			{/* Row 3: volume slider */}
			<Box width="100%">
				<VolumeSlider volume={props.volume} muted={props.muted} width={sliderWidth} />
			</Box>
		</Box>
	);
}

function CollapsedDjDeck() {
	return (
		<Box justifyContent="flex-end" width="100%" flexShrink={0}>
			<Box borderStyle="round" borderColor={t.orangeDim} paddingX={1}>
				<Text color={t.orange}>♪</Text>
			</Box>
		</Box>
	);
}

function ShortcutHintRow({ playing }: { playing: boolean }) {
	return (
		<Box justifyContent="space-between" width="100%" overflow="hidden">
			<Text color={t.muted}>^B prev</Text>
			<Text color={t.muted}>^P {playing ? "pause" : "play"}</Text>
			<Text color={t.muted}>^N next</Text>
			<Text color={t.muted}>^↑↓ vol</Text>
			<Text color={t.muted}>^M mute</Text>
		</Box>
	);
}

function sanitizeTrack(value: string): string {
	return value.replace(/[\u{1F300}-\u{1FAFF}]/gu, "").replace(/\s+/g, " ").trim();
}

export function DjDeck() {
	const [status, setStatus] = useState<DjStatus>(EMPTY);
	const [open, setOpen] = useState(true);
	// Local position that ticks every second, synced from poll
	const [localPos, setLocalPos] = useState<number | null>(null);
	// Waveform animation tick
	const [tick, setTick] = useState(0);
	const lastVolumeRef = useRef<number>(80);
	const djRef = useRef<{ instance: any; ready: boolean }>({ instance: null, ready: false });

	useEffect(() => {
		setOpenExternal = setOpen;
		return () => { setOpenExternal = null; };
	}, []);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const mod = await import("../../../../packages/music/dj.js");
				if (cancelled) return;
				djRef.current = { instance: new mod.DJ(), ready: true };
			} catch { /* DJ unavailable */ }
		})();
		return () => { cancelled = true; };
	}, []);

	// Poll real status every second
	useEffect(() => {
		const id = setInterval(async () => {
			const dj = djRef.current.instance;
			if (!dj || !djRef.current.ready) return;
			try {
				const s: DjStatus = await dj.status();
				setStatus(s);
				// Sync local position to real position on each poll
				if (s.position != null) setLocalPos(s.position);
				if (s.volume != null && s.volume > 0) lastVolumeRef.current = s.volume;
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
					const cur = status.volume ?? 80;
					if (cur > 0) {
						lastVolumeRef.current = cur;
						await dj.volume(0);
					} else {
						await dj.volume(lastVolumeRef.current || 80);
					}
				} else if (key.upArrow) {
					const next = Math.min(150, (status.volume ?? 80) + 10);
					await dj.volume(next);
					setStatus(s => ({ ...s, volume: next }));
				} else if (key.downArrow) {
					const next = Math.max(0, (status.volume ?? 80) - 10);
					await dj.volume(next);
					setStatus(s => ({ ...s, volume: next }));
				}
			} catch { /* never crash the TUI */ }
		},
		{ isActive: status.playing || status.title.length > 0 },
	);

	if (!status.playing && !status.title) return null;
	if (!open) return <CollapsedDjDeck />;

	const muted = status.volume != null && status.volume === 0;
	const volume = status.volume == null ? null : Math.round(status.volume);
	const track = truncateEnd(sanitizeTrack(status.title || "(loading)"), 82);

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
					artist="Instrumental"
					elapsed={fmt(localPos)}
					duration={fmt(status.duration)}
					volume={volume}
					muted={muted}
					tick={tick}
					termWidth={80}
				/>
			</Box>

			<Box marginTop={1}>
				<ShortcutHintRow playing={playing} />
			</Box>
		</Box>
	);
}
