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
	panel: theme.color.surface,
	panel2: theme.color.surface2,
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

function useTicker(enabled: boolean, ms: number) {
	const [tick, setTick] = useState(0);
	useEffect(() => {
		if (!enabled) return;
		const id = setInterval(() => setTick((v) => v + 1), ms);
		return () => clearInterval(id);
	}, [enabled, ms]);
	return tick;
}

function MiniReel({ spinning, reverse = false }: { spinning: boolean; reverse?: boolean }) {
	const tick = useTicker(spinning, 180);
	const frames = reverse ? ["◷", "◶", "◵", "◴"] : ["◴", "◵", "◶", "◷"];
	return (
		<Box width={3} justifyContent="center" flexShrink={0}>
			<Text color={ui.orange}>{frames[tick % frames.length]}</Text>
		</Box>
	);
}

function Hint({ children }: { children: React.ReactNode }) {
	return <Text color={ui.muted}>{children}</Text>;
}

function ShortcutHintRow({ playing }: { playing: boolean }) {
	return (
		<Box marginTop={1} justifyContent="space-between" width="100%">
			<Hint>^⇧B prev</Hint>
			<Hint>^⇧P {playing ? "pause" : "play"}</Hint>
			<Hint>^⇧N next</Hint>
			<Hint>^⇧↑↓ vol</Hint>
			<Hint>^⇧M mute</Hint>
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
			// Require Ctrl+Shift (matches the on-screen hint "^⇧P pause" etc).
			// We test the *uppercase character* rather than `key.shift` because
			// some macOS terminals don't set the shift flag reliably on
			// ctrl-shift combos, but they do deliver the uppercase letter.
			// This also stops plain Ctrl+P from accidentally firing pause —
			// previously a real collision with Ctrl+P (predict) in app.tsx.
			if (!key.ctrl) return;
			const dj = djRef.current.instance;
			if (!dj) return;
			try {
				if (input === "P") {
					await dj.pause();
				} else if (input === "N") {
					await dj.skip();
				} else if (input === "B") {
					const hist: { title: string; url: string }[] = dj.getHistory?.() ?? [];
					const prev = hist[hist.length - 2];
					if (prev?.url) await dj.play(prev.url);
				} else if (input === "M") {
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
	const station = "8GENT FM";
	const track = truncateEnd(status.title || "(loading)", 82);
	const artist = "Instrumental";

	return (
		<Box
			width="100%"
			height={8}
			borderStyle="round"
			borderColor={ui.orangeDim}
			paddingX={1}
			flexDirection="column"
			flexShrink={0}
		>
			<Box justifyContent="space-between" width="100%">
				<Text color={ui.orange}>● {station}</Text>
				<Text color={ui.muted}>/dj close</Text>
			</Box>

			<Box marginTop={1} width="100%" alignItems="center">
				<MiniReel spinning={playing} />

				<Box
					flexGrow={1}
					minWidth={0}
					marginX={1}
					borderStyle="single"
					borderColor={ui.panel2}
					paddingX={1}
					flexDirection="column"
				>
					<Box justifyContent="space-between" width="100%">
						<Text color={ui.cream} wrap="truncate-end">
							{track}
						</Text>
						<Text color={ui.orangeDim}>{fmt(status.position)}</Text>
					</Box>

					<Box justifyContent="space-between" width="100%">
						<Text color={ui.orange} wrap="truncate-end">
							{artist}
						</Text>
						<Text color={ui.orangeDim}>{fmt(status.duration)}</Text>
					</Box>

					<Box justifyContent="space-between" width="100%">
						<Text color={ui.orangeDim}>▂▃▅▆▅▃▂ ━━━━━░░</Text>
						<Text color={muted ? ui.dim : ui.orangeDim}>
							{muted ? "muted" : volume == null ? "vol --" : `vol ${volume}%`}
						</Text>
					</Box>
				</Box>

				<MiniReel spinning={playing} reverse />
			</Box>

			<ShortcutHintRow playing={playing} />
		</Box>
	);
}
