/**
 * DjDeck: the DJ, one row above the footer while a track is loaded.
 *
 *   DJ ▶ No Agreement (LP)  Fela Kuti  Key: F minor (est.)   1:15 / 31:05  vol 60%  [^D] keys
 *
 * [^D] gives the deck the keyboard, like the buttons on a car stereo, and a
 * second row shows the key caps that work right then (#3188):
 *
 *      [B ◀◀] [Space ▶❚] [N ▶▶] [S ■]  [-] [+] vol 60%  [M] mute  [Esc] chat
 *
 * Plain keys only reach the deck while it has the keyboard, so they never type
 * into the chat and never fight the app's Ctrl shortcuts. Esc or ^D hands the
 * keyboard back (app.tsx); so does stopping.
 *
 * Cost and motion (#3184):
 * - One 1 s poll of the player. The deck repaints only when what it draws
 *   changes. Every repaint is a full Ink frame (about 50 ms of CPU on a
 *   160x48 screen), so the clock moves in 5 s steps; /dj np reads the exact
 *   position as text. Nothing loops, and there is no waveform: the deck does
 *   not draw audio it does not read.
 * - Under reduced motion or NO_COLOR the clock moves in 15 s steps.
 * - Nothing loaded: no deck row and no footer segment; the quiet state draws
 *   nothing (#3238).
 *
 * Words carry every state, so it reads the same under NO_COLOR, and each row
 * has an aria-label for screen readers. `/dj close` hides the row (the footer
 * then names the track), `/dj open` brings it back; the choice persists in the
 * workspace DB at app_state(`tui`, `djDeckExpanded`) (#2341).
 */

import { Box, Text, useInput } from "ink";
import React, { useEffect, useRef, useState } from "react";
import { colourPolicy } from "../lib/colour-policy.js";
import { keepIfSame } from "../lib/keep-if-same.js";
import { reducedMotionFromEnv } from "../lib/motion.js";
import { t } from "../theme.js";
import { KeyCapRow } from "./KeyCap.js";

// ── Persistence helpers ───────────────────────────────────────────────
// Lazy + best-effort: never let a DB error crash the deck. If the workspace
// DB is unavailable (e.g. tests, sandboxed CI), we silently fall back to the
// in-memory default (shown).

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

export interface DjStatus {
	playing: boolean;
	paused: boolean;
	looping: boolean;
	title: string;
	url: string;
	position: number | null;
	duration: number | null;
	volume: number | null;
	queueSize: number;
	/** From the source's metadata (#3192); empty when it carries none. */
	name?: string;
	artists?: string[];
	keyLabel?: string;
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
	name: "",
	artists: [],
	keyLabel: "",
};

let setOpenExternal: ((v: boolean) => void) | null = null;
export function setDjDeckOpen(open: boolean): void {
	setOpenExternal?.(open);
}

/** Whether a track is loaded right now; ^D only gives the deck the keyboard then. */
let trackLoaded = false;
export function djHasTrack(): boolean {
	return trackLoaded;
}

/** Whether the deck holds still: reduced motion asked for, or NO_COLOR (#3184). */
export function deckStill(env: Record<string, string | undefined> = process.env): boolean {
	return reducedMotionFromEnv(env) || colourPolicy(env) === "none";
}

/** Seconds per clock step: 5 normally, 15 when the deck holds still. */
export function clockStep(still: boolean): number {
	return still ? 15 : 5;
}

/**
 * What the deck shows from one poll, reduced to what it can draw. The
 * position is floored to the clock step, so two polls inside the same step
 * are equal and keepIfSame skips the render.
 */
export function deckView(s: DjStatus, step: number): DjStatus {
	const pos = s.position;
	return {
		...s,
		position: pos == null || !Number.isFinite(pos) ? null : Math.floor(pos / step) * step,
		duration: s.duration == null || !Number.isFinite(s.duration) ? null : Math.floor(s.duration),
		volume: s.volume == null ? null : Math.round(s.volume),
	};
}

function fmt(s: number | null): string {
	if (s == null || !Number.isFinite(s) || s < 0) return "0:00";
	const m = Math.floor(s / 60);
	const r = Math.floor(s % 60);
	return `${m}:${r.toString().padStart(2, "0")}`;
}

function sanitizeTrack(value: string): string {
	return value
		.replace(/[\u{1F300}-\u{1FAFF}]/gu, "")
		.replace(/\s+/g, " ")
		.trim();
}

// ── Key caps (HUD system role "key cap": the cap is its own border) ──

/**
 * The deck's controls, in car-stereo order. Every symbol draws in one cell in
 * Menlo; ⏯ ⏭ ⏮ fall back to two-cell emoji and would shift the row.
 */
export const DJ_KEYS: readonly { cap: string; verb: string; spoken: string }[] = [
	{ cap: "B ◀◀", verb: "", spoken: "B previous" },
	{ cap: "Space ▶❚", verb: "", spoken: "Space play or pause" },
	{ cap: "N ▶▶", verb: "", spoken: "N next" },
	{ cap: "S ■", verb: "", spoken: "S stop" },
	{ cap: "-", verb: "", spoken: "minus volume down" },
	{ cap: "+", verb: "vol", spoken: "plus volume up" },
	{ cap: "M", verb: "mute", spoken: "M mute" },
	{ cap: "Esc", verb: "chat", spoken: "Escape back to chat" },
];

/** Which deck control a key press is, or null. Plain keys: they only arrive while the deck has the keyboard. */
export function djControl(
	input: string | undefined,
): "prev" | "pause" | "next" | "stop" | "down" | "up" | "mute" | null {
	switch (input) {
		case "b":
		case "B":
			return "prev";
		case " ":
			return "pause";
		case "n":
		case "N":
			return "next";
		case "s":
		case "S":
			return "stop";
		case "-":
		case "_":
			return "down";
		case "+":
		case "=":
			return "up";
		case "m":
		case "M":
			return "mute";
		default:
			return null;
	}
}

/** The second row, only while the deck has the keyboard. It sits under the track, past "DJ ▶ ". */
export function DjKeysRow({ volume = null }: { volume?: number | null } = {}) {
	const groups = [DJ_KEYS.slice(0, 4), DJ_KEYS.slice(4, 6), DJ_KEYS.slice(6, 7), DJ_KEYS.slice(7)];
	return (
		<Box
			width="100%"
			flexShrink={0}
			height={1}
			overflow="hidden"
			aria-label={`DJ keys: ${DJ_KEYS.map((k) => k.spoken).join(", ")}.`}
		>
			<KeyCapRow
				idPrefix="dj"
				caps={groups.flatMap((g, gi) =>
					g.map((k, i) => ({
						cap: k.cap,
						verb:
							k.verb === "vol" && volume != null
								? `vol ${volume === 0 ? "muted" : `${volume}%`}`
								: k.verb,
						// Past "DJ ▶ " on the first cap, one space inside a group, two between.
						gap: gi === 0 && i === 0 ? 5 : i === 0 ? 2 : 1,
					})),
				)}
			/>
		</Box>
	);
}

/** The one row a loaded track takes. */
export function DjRow(props: {
	paused: boolean;
	track: string;
	artist: string;
	keyLabel: string;
	elapsed: string;
	duration: string;
	volume: number | null;
	/** The deck has the keyboard: the second row shows the caps, so this row drops its [^D] hint. */
	keysActive: boolean;
	/**
	 * Room for the volume on this row. Below 110 columns it gives way so the
	 * track, the artist and the key fit 80; the key-cap row shows it instead.
	 */
	showVolume?: boolean;
}) {
	const showVolume = props.showVolume !== false;
	const muted = props.volume === 0;
	const vol = props.volume == null ? "vol --" : muted ? "muted" : `vol ${props.volume}%`;
	const state = props.paused ? "paused" : "playing";
	const spoken = [
		`DJ ${state}: ${props.track}`,
		props.artist ? `by ${props.artist}` : "",
		props.keyLabel,
		`${props.elapsed} of ${props.duration}`,
		muted ? "muted" : props.volume == null ? "" : `volume ${props.volume}`,
		props.keysActive ? "" : "Control D for DJ keys",
	]
		.filter(Boolean)
		.join(", ");
	return (
		<Box width="100%" flexShrink={0} height={1} aria-label={`${spoken}.`}>
			<Box flexShrink={0}>
				<Text bold color={t.orange}>
					DJ
				</Text>
				<Text color={props.paused ? t.textTertiary : t.teal}>{props.paused ? " ❚❚ " : " ▶ "}</Text>
			</Box>
			<Box flexGrow={1} flexShrink={1} minWidth={0}>
				<Text wrap="truncate-end">
					<Text color={t.textPrimary}>{props.track}</Text>
					{props.artist ? <Text color={t.textTertiary}>{`  ${props.artist}`}</Text> : null}
				</Text>
			</Box>
			{props.keyLabel ? (
				<Box flexShrink={0}>
					<Text color={t.textSecondary}>{`  ${props.keyLabel}`}</Text>
				</Box>
			) : null}
			<Box flexShrink={0}>
				<Text color={t.textTertiary}>
					{`  ${props.elapsed} / ${props.duration}${showVolume ? `  ${vol}` : ""}`}
				</Text>
				{props.keysActive ? null : (
					<Box marginLeft={2}>
						<KeyCapRow caps={[{ cap: "^D", verb: "keys" }]} idPrefix="djrow" />
					</Box>
				)}
			</Box>
		</Box>
	);
}

/** The station segment at the start of the one-row footer, only while a
 *  track is loaded and the DJ row is closed (/dj close): "▶ DJ" and the
 *  track. Nothing loaded draws nothing (#3238). It takes its natural width
 *  up to `width`, the columns the status segments after it budget for it. */
export function FmFooterSegment(props: {
	width: number;
	playing: boolean;
	paused?: boolean;
	track: string;
}) {
	const glyph = props.paused ? "❚❚ " : "▶ ";
	const natural = glyph.length + 2 + (props.track ? props.track.length + 1 : 0);
	return (
		<Box width={Math.min(natural, props.width)} flexShrink={0} overflow="hidden">
			<Text wrap="truncate-end">
				<Text color={props.playing && !props.paused ? t.teal : t.textTertiary}>{glyph}</Text>
				<Text color={t.orange} bold>
					DJ
				</Text>
				{props.track ? <Text color={t.textPrimary}> {props.track}</Text> : null}
			</Text>
		</Box>
	);
}

// Multiple useState calls model independent slices with different update sources; a reducer would conflate orthogonal events.
// react-doctor-disable-next-line react-doctor/prefer-useReducer
export function DjDeck({
	footer,
	fmWidth = 14,
	columns = 80,
	keysActive = false,
	onKeysDone,
}: {
	/** When set, the deck renders as the first segment of a one-row footer
	 *  and `footer` fills the rest of that row. As a function it is told
	 *  whether the station segment is drawn before it (#3238), and whether a
	 *  track is loaded (^D only does something then). The DJ row opens above it
	 *  while a track is loaded. */
	footer?: React.ReactNode | ((station: boolean, hasTrack: boolean) => React.ReactNode);
	fmWidth?: number;
	/** Terminal columns: below 110 the row leaves the volume to the key-cap row. */
	columns?: number;
	/** The deck has the keyboard (^D): plain keys drive it and a key-cap row shows. */
	keysActive?: boolean;
	/** Hand the keyboard back to the chat (after stop, or when nothing is loaded). */
	onKeysDone?: () => void;
} = {}) {
	const [status, setStatus] = useState<DjStatus>(EMPTY);
	// State value is read in render or feeds a derived value used in render — useRef would break visible output.
	// react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers
	const [open, setOpen] = useState(true);
	// displayVolume: updates immediately for visual feedback; actual dj.volume() is debounced 1s
	const [displayVolume, setDisplayVolume] = useState<number | null>(null);
	const lastVolumeRef = useRef<number>(60);
	const pendingVolumeRef = useRef<number | null>(null);
	const volumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const djRef = useRef<{ instance: any; ready: boolean }>({ instance: null, ready: false });

	useEffect(() => {
		setOpenExternal = setOpen;
		return () => {
			setOpenExternal = null;
		};
	}, []);

	// Hydrate from workspace DB once on mount. Default = shown if absent.
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
				const dj = new mod.DJ();
				djRef.current = { instance: dj, ready: true };
				// Show the remembered volume the next track starts at (#3190). Setting
				// it here would do nothing: mpv takes it at spawn, from the same store.
				const v = dj.preferredVolume();
				lastVolumeRef.current = v;
				setDisplayVolume(v);
			} catch {
				/* DJ unavailable */
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	// Poll real status every second. The only timer the deck runs (#3184):
	// no local clock and no animation tick. What it shows is reduced to the
	// clock step first, so a poll that changes nothing visible renders nothing.
	// react-doctor-disable-next-line react-doctor/no-cascading-set-state
	useEffect(() => {
		const step = clockStep(deckStill());
		const id = setInterval(async () => {
			const dj = djRef.current.instance;
			if (!dj || !djRef.current.ready) return;
			try {
				const s: DjStatus = deckView(await dj.status(), step);
				setStatus(keepIfSame(s));
				if (s.volume != null && s.volume > 0) {
					lastVolumeRef.current = s.volume;
					// Only sync display volume if not currently scrubbing
					if (pendingVolumeRef.current == null) setDisplayVolume(s.volume);
				}
			} catch {
				/* keep last known status */
			}
		}, 1000);
		return () => clearInterval(id);
	}, []);

	const hasTrack = status.playing;

	// ^D asks djHasTrack(); the keyboard goes back to the chat as soon as nothing is loaded.
	useEffect(() => {
		trackLoaded = hasTrack;
		if (keysActive && !hasTrack) onKeysDone?.();
	}, [keysActive, hasTrack, onKeysDone]);

	// Adjust display volume immediately; debounce actual dj.volume() by 1s
	const scrubVolume = (delta: number) => {
		const base = displayVolume ?? status.volume ?? lastVolumeRef.current;
		const next = Math.max(0, Math.min(150, base + delta));
		setDisplayVolume(next);
		pendingVolumeRef.current = next;
		if (next > 0) lastVolumeRef.current = next;
		if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current);
		volumeTimerRef.current = setTimeout(async () => {
			const dj = djRef.current.instance;
			const vol = pendingVolumeRef.current;
			if (!dj || vol == null) return;
			try {
				await dj.volume(vol);
				setStatus((s) => ({ ...s, volume: vol }));
			} catch {}
			pendingVolumeRef.current = null;
		}, 1000);
	};

	useInput(
		async (input, key) => {
			if (key.ctrl || key.meta) return;
			const dj = djRef.current.instance;
			if (!dj) return;
			const c = djControl(input);
			try {
				if (c === "pause") {
					await dj.pause();
					setStatus((s) => ({ ...s, paused: !s.paused }));
				} else if (c === "next") {
					await dj.skip();
				} else if (c === "prev") {
					const hist: { title: string; url: string }[] = dj.getHistory?.() ?? [];
					const prev = hist[hist.length - 2];
					if (prev?.url) await dj.play(prev.url);
				} else if (c === "stop") {
					dj.stop();
					setStatus(EMPTY);
					onKeysDone?.();
				} else if (c === "down") {
					scrubVolume(-5);
				} else if (c === "up") {
					scrubVolume(5);
				} else if (c === "mute") {
					const cur = displayVolume ?? status.volume ?? lastVolumeRef.current;
					if (cur > 0) {
						lastVolumeRef.current = cur;
						setDisplayVolume(0);
						await dj.volume(0);
					} else {
						const restore = lastVolumeRef.current || 60;
						setDisplayVolume(restore);
						await dj.volume(restore);
					}
				}
			} catch {
				/* never crash the TUI */
			}
		},
		{ isActive: keysActive && hasTrack },
	);

	const effectiveVolume = displayVolume ?? status.volume;
	const volume = effectiveVolume == null ? null : Math.round(effectiveVolume);
	const playing = status.playing && !status.paused;
	const track = hasTrack ? sanitizeTrack(status.name || status.title || "(loading)") : "";
	// Only what the source names (#3192); never a placeholder artist.
	const artists = (status.artists ?? []).map(sanitizeTrack).filter(Boolean).join(", ");

	const row =
		hasTrack && open ? (
			<DjRow
				paused={status.paused}
				track={track}
				artist={artists}
				keyLabel={status.keyLabel ?? ""}
				elapsed={fmt(status.position)}
				duration={fmt(status.duration)}
				volume={volume}
				keysActive={keysActive}
				showVolume={columns >= 110}
			/>
		) : null;
	const keysRow = hasTrack && keysActive ? <DjKeysRow volume={volume} /> : null;

	// One home per fact (#3238): the DJ row names the track while it is open,
	// so the footer carries the station only when a track is loaded and the
	// row is closed (/dj close). Nothing loaded draws nothing: the NOW strip
	// already says whether the agent is working, so no "idle" or "agent pulse".
	const station = hasTrack && !open;
	const segment = station ? (
		<FmFooterSegment width={fmWidth} playing={playing} paused={status.paused} track={track} />
	) : null;
	const footerNode = typeof footer === "function" ? footer(station, hasTrack) : footer;

	return (
		<Box width="100%" flexDirection="column" flexShrink={0}>
			{row}
			{keysRow}
			{footer === undefined && (row || keysRow) ? null : (
				<Box width="100%" flexShrink={0} height={1}>
					{segment}
					{footerNode}
				</Box>
			)}
		</Box>
	);
}
