/**
 * Control store (#5062, slice 1 of #5067): one lazy, event-driven reader shared
 * by the Control tab and the side-panel LOOPS block.
 *
 * Nothing is read and nothing is watched until the first subscriber arrives;
 * the last unsubscribe closes every watcher. Reads happen on a file change
 * (fs.watch, debounced), never on a timer. The machine header is sampled with
 * two cheap OS calls on each read, plus a slow refresh while someone is looking.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type ControlConfig,
	type LoopRow,
	type ReadResult,
	loadControlConfig,
	readControlState,
	watchTargets,
} from "./control-state.js";

export interface MachineHeader {
	load: number;
	freeDiskGB: number | null;
	diskFloorGB: number | null;
	helpers: number;
	helperCap: number | null;
}

export interface ControlSnapshot extends ReadResult {
	header: MachineHeader;
	at: number;
}

/** A refresh of the header while the tab is open. Never under 2 s. */
export const HEADER_REFRESH_MS = 30_000;
export const WATCH_DEBOUNCE_MS = 250;

export function freeDiskGB(dir: string = os.homedir()): number | null {
	try {
		const s = fs.statfsSync(dir);
		return Math.floor((Number(s.bavail) * Number(s.bsize)) / 1024 ** 3);
	} catch {
		return null;
	}
}

export function buildHeader(cfg: ControlConfig, rows: readonly LoopRow[]): MachineHeader {
	return {
		load: Math.round(os.loadavg()[0] * 10) / 10,
		freeDiskGB: freeDiskGB(),
		diskFloorGB: cfg.diskFloorGB,
		helpers: rows.filter((r) => r.state === "running").length,
		helperCap: cfg.helperCap,
	};
}

export interface StoreDeps {
	load?: () => { cfg: ControlConfig; result: ReadResult };
	watch?: (target: string, onChange: () => void) => { close(): void } | null;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (t: unknown) => void;
}

function defaultWatch(target: string, onChange: () => void): { close(): void } | null {
	try {
		// A file is watched through its folder so an atomic replace is still seen.
		const isDir = fs.statSync(target).isDirectory();
		const dir = isDir ? target : path.dirname(target);
		const base = isDir ? null : path.basename(target);
		return fs.watch(dir, { persistent: false }, (_ev, name) => {
			if (base === null || !name || name === base) onChange();
		});
	} catch {
		return null;
	}
}

export function createControlStore(deps: StoreDeps = {}) {
	const load =
		deps.load ??
		(() => {
			const cfg = loadControlConfig();
			return { cfg, result: readControlState(cfg) };
		});
	const watch = deps.watch ?? defaultWatch;
	const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
	const clearTimer = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout));

	const listeners = new Set<() => void>();
	let snapshot: ControlSnapshot | null = null;
	let watchers: { close(): void }[] = [];
	let debounce: unknown = null;
	let slow: unknown = null;
	let currentCfg: ControlConfig | null = null;
	let headerSubs = 0;

	function refresh(): void {
		try {
			const { cfg, result } = load();
			currentCfg = cfg;
			snapshot = { ...result, header: buildHeader(cfg, result.rows), at: Date.now() };
		} catch {
			// A read that fails keeps the last good snapshot.
		}
		for (const fn of [...listeners]) fn();
	}

	function startWatching(): void {
		if (!currentCfg) return;
		for (const target of watchTargets(currentCfg)) {
			const w = watch(target, () => {
				if (debounce !== null) clearTimer(debounce);
				debounce = setTimer(() => {
					debounce = null;
					refresh();
				}, WATCH_DEBOUNCE_MS);
			});
			if (w) watchers.push(w);
		}
	}

	// The header's load and disk move without any file changing, so a slow
	// refresh runs, but only while a subscriber that shows the header is mounted.
	function tickSlow(): void {
		slow = setTimer(() => {
			if (snapshot && headerSubs > 0 && currentCfg) {
				snapshot = { ...snapshot, header: buildHeader(currentCfg, snapshot.rows), at: Date.now() };
				for (const fn of [...listeners]) fn();
			}
			tickSlow();
		}, HEADER_REFRESH_MS);
		(slow as { unref?: () => void } | null)?.unref?.();
	}

	function stopSlow(): void {
		if (slow !== null) clearTimer(slow);
		slow = null;
	}

	function stopWatching(): void {
		for (const w of watchers) w.close();
		watchers = [];
		if (debounce !== null) clearTimer(debounce);
		debounce = null;
		stopSlow();
		snapshot = null;
	}

	return {
		/**
		 * First subscriber reads once and starts watching; the last one stops
		 * everything. `header` subscribers also get the slow header refresh.
		 */
		subscribe(fn: () => void, opts: { header?: boolean } = {}): () => void {
			const first = listeners.size === 0;
			listeners.add(fn);
			if (first) {
				refresh();
				startWatching();
			}
			if (opts.header) {
				headerSubs += 1;
				if (headerSubs === 1) tickSlow();
			}
			return () => {
				listeners.delete(fn);
				if (opts.header) {
					headerSubs -= 1;
					if (headerSubs === 0) stopSlow();
				}
				if (listeners.size === 0) stopWatching();
			};
		},
		get: (): ControlSnapshot | null => snapshot,
		subscribers: (): number => listeners.size,
	};
}

export const controlStore = createControlStore();
