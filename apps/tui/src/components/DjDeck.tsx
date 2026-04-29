/**
 * DjDeck — premium terminal audio deck. Flat 3-row LCD: track + elapsed,
 * artist + duration, waveform + vol. Mini reels flank the LCD; transport
 * hints sit underneath. Fixed height keeps the bottom stack stable.
 *
 * Hidden until something has been loaded. /dj close minimises to a ♪
 * chip via the exported `setDjDeckOpen()` handle. Keyboard transport is
 * wired through Ink's `useInput` — Ctrl-modifier only because terminals
 * cannot reliably distinguish Ctrl+Shift from Ctrl. The hint labels keep
 * the `^⇧` prefix purely as visual shorthand.
 */

import { Box, Text, useInput } from "ink";
import React, { useEffect, useRef, useState } from "react";
import { theme } from "../theme.js";

const ui = {
	cream: theme.color.cream,
	muted: theme.color.muted,
	dim: theme.color.dim,
	orange: theme.color.orange,
	orangeDim: theme.color.orangeDim,
} as const;

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
	playing: false,
	paused: false,
	looping: false,
	title: "",
	url: "",
	position: null,
	duration: null,
	volume: null,
	queueSize: 0,
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

function ShortcutHintRow({ playing }: { playing: boolean }) {
	return (
		<Box justifyContent="space-between" width="100%" overflow="hidden">
			<Text color={ui.muted} wrap="truncate-end">
				^B prev
			</Text>
			<Text color={ui.muted} wrap="truncate-end">
				^P {playing ? "pause" : "play"}
			</Text>
			<Text color={ui.muted} wrap="truncate-end">
				^N next
			</Text>
			<Text color={ui.muted} wrap="truncate-end">
				^↑↓ vol
			</Text>
			<Text color={ui.muted} wrap="truncate-end">
				^M mute
			</Text>
		</Box>
	);
}

/** Strip emoji + collapse whitespace so terminal width math stays correct. */
function sanitizeTrack(value: string): string {
	return value
		.replace(/[\u{1F300}-\u{1FAFF}]/gu, "")
		.replace(/\s+/g, " ")
		.trim();
}

function StereoDisplay(props: {
	playing: boolean;
	track: string;
	artist: string;
	elapsed: string;
	duration: string;
	volume: number | null;
	muted: boolean;
}) {
	return (
		<Box
			width="100%"
			borderStyle="single"
			borderColor={ui.orangeDim}
			paddingX={1}
			flexDirection="column"
		>
			<Box justifyContent="space-between" width="100%">
				<Box minWidth={0} flexGrow={1}>
					<Text color={ui.orange}>{props.playing ? "◴ " : "○ "}</Text>
					<Text color={ui.cream} wrap="truncate-end">
						{props.track}
					</Text>
				</Box>
				<Text color={ui.orange}>{props.playing ? " ◷" : " ○"}</Text>
			</Box>

			<Box justifyContent="space-between" width="100%">
				<Text color={ui.orange} wrap="truncate-end">
					{props.artist}
				</Text>
				<Text color={ui.orangeDim}>
					{props.elapsed} / {props.duration}
				</Text>
			</Box>

			<Box justifyContent="space-between" width="100%">
				<Text color={ui.orangeDim}>▂▃▅▆▅▃▂ ━━━━━░░</Text>
				<Text color={props.muted ? ui.dim : ui.orangeDim}>
					{props.muted ? "muted" : props.volume == null ? "vol --" : `vol ${props.volume}%`}
				</Text>
			</Box>
		</Box>
	);
}

function CollapsedDjDeck() {
	return (
		<Box justifyContent="flex-end" width="100%" flexShrink={0}>
			<Box borderStyle="round" borderColor={ui.orangeDim} paddingX={1}>
				<Text color={ui.orange}>♪</Text>
			</Box>
		</Box>
	);
}

export function DjDeck() {
	const [status, setStatus] = useState<DjStatus>(EMPTY);
	const [open, setOpen] = useState(true);
	const lastVolumeRef = useRef<number>(80);
	const djRef = useRef<{ instance: any; ready: boolean }>({ instance: null, ready: false });

	useEffect(() => {
		setOpenExternal = setOpen;
		return () => {
			setOpenExternal = null;
		};
	}, []);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const mod = await import("../../../../packages/music/dj.js");
				if (cancelled) return;
				djRef.current = { instance: new mod.DJ(), ready: true };
			} catch {
				/* DJ unavailable; deck stays hidden */
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		const id = setInterval(async () => {
			const dj = djRef.current.instance;
			if (!dj || !djRef.current.ready) return;
			try {
				const s: DjStatus = await dj.status();
				setStatus(s);
				if (s.volume != null && s.volume > 0) lastVolumeRef.current = s.volume;
			} catch {
				/* keep last known status */
			}
		}, 1000);
		return () => clearInterval(id);
	}, []);

	useInput(
		async (input, key) => {
			// Ctrl + letter, no shift — matches the visible hints (^P, ^B, ^N, ^M).
			// Gate `isActive` below ensures the chat input keeps Ctrl+P/B/N when
			// no track is loaded; once a track is playing the deck owns these.
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
					await dj.volume(Math.min(150, (status.volume ?? 80) + 10));
				} else if (key.downArrow) {
					await dj.volume(Math.max(0, (status.volume ?? 80) - 10));
				}
			} catch {
				/* swallow — HUD never crashes the TUI */
			}
		},
		{ isActive: status.playing || status.title.length > 0 },
	);

	if (!status.playing && !status.title) return null;

	if (!open) return <CollapsedDjDeck />;

	const playing = status.playing && !status.paused;
	const muted = status.volume != null && status.volume === 0;
	const volume = status.volume == null ? null : Math.round(status.volume);
	const track = truncateEnd(sanitizeTrack(status.title || "(loading)"), 82);

	return (
		<Box
			width="100%"
			borderStyle="round"
			borderColor={ui.orangeDim}
			paddingX={1}
			flexDirection="column"
			flexShrink={0}
		>
			<Box justifyContent="space-between" width="100%">
				<Text color={ui.orange}>● 8GENT FM</Text>
				<Text color={ui.muted}>/dj close</Text>
			</Box>

			<Box marginTop={1}>
				<StereoDisplay
					playing={playing}
					track={track}
					artist="Instrumental"
					elapsed={fmt(status.position)}
					duration={fmt(status.duration)}
					volume={volume}
					muted={muted}
				/>
			</Box>

			<Box marginTop={1}>
				<ShortcutHintRow playing={playing} />
			</Box>
		</Box>
	);
}
