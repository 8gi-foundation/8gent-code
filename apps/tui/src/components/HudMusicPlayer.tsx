/**
 * HudMusicPlayer — compact bottom-bar music status + controls.
 *
 * Hidden when nothing is playing. When the DJ singleton has a track
 * loaded, renders one line:
 *
 *   ▶ Track Name  [▮▮▮▮▮▮▯▯▯▯] 1:23/3:45  🔊 80%   ⌃⇧P ⏯  ⌃⇧B ⏮  ⌃⇧N ⏭
 *
 * Hotkeys (all Ctrl+Shift+ to avoid clashing with chat input):
 *   ⌃⇧P  play/pause toggle
 *   ⌃⇧B  prev (skip back to previous in history)
 *   ⌃⇧N  next (skip to next in queue)
 *   ⌃⇧M  mute (volume toggle 0/80)
 *   ⌃⇧↑  vol +10
 *   ⌃⇧↓  vol −10
 *
 * Polls `dj.status()` every second; cheap and avoids needing an event
 * channel out of the DJ singleton.
 */

import { Box, Text, useInput } from "ink";
import React, { useEffect, useRef, useState } from "react";

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

function fmt(s: number | null): string {
	if (s == null || !Number.isFinite(s) || s < 0) return "0:00";
	const m = Math.floor(s / 60);
	const r = Math.floor(s % 60);
	return `${m}:${r.toString().padStart(2, "0")}`;
}

function progressBar(position: number | null, duration: number | null, width = 10): string {
	if (!position || !duration || duration <= 0) return "▯".repeat(width);
	const filled = Math.round((position / duration) * width);
	return "▮".repeat(Math.min(filled, width)) + "▯".repeat(Math.max(0, width - filled));
}

function volumeBar(volume: number | null, width = 5): string {
	if (volume == null) return "▯".repeat(width);
	const filled = Math.round((Math.max(0, Math.min(100, volume)) / 100) * width);
	return "▮".repeat(filled) + "▯".repeat(width - filled);
}

export function HudMusicPlayer() {
	const [status, setStatus] = useState<DjStatus>(EMPTY);
	const lastVolumeRef = useRef<number>(80);
	const djRef = useRef<{
		instance: any;
		ready: boolean;
	}>({ instance: null, ready: false });

	// Lazy-load the DJ singleton so we don't pay the import cost until
	// the user actually plays something through /dj.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const mod = await import("../../../../packages/music/dj.js");
				if (cancelled) return;
				djRef.current = { instance: new mod.DJ(), ready: true };
			} catch {
				/* DJ unavailable; HUD stays hidden */
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	// Poll DJ status every 1s. Cheap because mpv IPC is local socket.
	useEffect(() => {
		const tick = setInterval(async () => {
			const dj = djRef.current.instance;
			if (!dj || !djRef.current.ready) return;
			try {
				const s: DjStatus = await dj.status();
				setStatus(s);
				if (s.volume != null && s.volume > 0) lastVolumeRef.current = s.volume;
			} catch {
				/* ignore — keep last known status */
			}
		}, 1000);
		return () => clearInterval(tick);
	}, []);

	useInput(async (input, key) => {
		// Require BOTH ctrl+shift AND uppercase letter input. Some macOS
		// terminals don't reliably set `key.shift` for ctrl-shift combos,
		// but they do deliver the uppercase character — so the upper-case
		// guard is what actually keeps Ctrl+P alone from firing pause.
		if (!key.ctrl || !key.shift) return;
		const dj = djRef.current.instance;
		if (!dj) return;
		try {
			if (input === "P") {
				await dj.pause();
			} else if (input === "N") {
				await dj.skip();
			} else if (input === "B") {
				const hist = dj.getHistory?.() ?? [];
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
				const next = Math.min(150, (status.volume ?? 80) + 10);
				await dj.volume(next);
			} else if (key.downArrow) {
				const next = Math.max(0, (status.volume ?? 80) - 10);
				await dj.volume(next);
			}
		} catch {
			/* swallow — HUD never crashes the TUI */
		}
	});

	if (!status.playing) return null;

	const icon = status.paused ? "⏸" : "▶";
	const titleDisplay = status.title || "(loading)";
	const truncatedTitle = titleDisplay.length > 28 ? `${titleDisplay.slice(0, 27)}…` : titleDisplay;

	return (
		<Box flexDirection="row" gap={2} paddingX={1} borderStyle="single" borderColor="yellow">
			<Text color="yellow" bold>
				{icon}
			</Text>
			<Text>{truncatedTitle}</Text>
			<Text color="yellow">{progressBar(status.position, status.duration)}</Text>
			<Text dimColor>
				{fmt(status.position)}/{fmt(status.duration)}
			</Text>
			<Text>
				<Text dimColor>vol </Text>
				<Text color="yellow">{volumeBar(status.volume)}</Text>
				<Text dimColor> {Math.round(status.volume ?? 0)}%</Text>
			</Text>
			<Text dimColor>⌃⇧P ⏯ · ⌃⇧B ⏮ · ⌃⇧N ⏭ · ⌃⇧↑↓ vol · ⌃⇧M mute</Text>
		</Box>
	);
}
