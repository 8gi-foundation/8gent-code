/**
 * "Update available" notice for the TUI. One background check, at most every
 * 24 hours, never blocks startup, silent on any error. Opt-in with
 * EIGHT_UPDATE_CHECK=1; EIGHT_NO_UPDATE_CHECK=1 stays a hard off or `"updateCheck": false` in settings.json.
 *
 * The check changes nothing: a source checkout only fetches its own origin's
 * main into refs/remotes/origin/main; binary and npm only read the release
 * list or registry.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkUpdate } from "./cli-maintenance";
import { type FetchLike, detectChannel } from "./self-update";
import {
	type ExecFn,
	checkSourceAhead,
	defaultExec,
	findCheckoutRoot,
	resolveExecutable,
} from "./source-update";
import { dataDir } from "./update-resume";

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

type Env = Record<string, string | undefined>;

export interface NoticeState {
	checkedAt: number;
	/** Set when the last check found something newer. */
	available?: { from: string; to: string; label: string };
}

export function noticeText(from: string, to: string): string {
	return `Update available (${from} -> ${to}). Run 8gent update, or type /update.`;
}

/** The launch update check is opt-in: only EIGHT_UPDATE_CHECK=1|true|on|yes turns it on. */
export function isUpdateCheckEnabled(env: Env = process.env): boolean {
	const v = (env.EIGHT_UPDATE_CHECK ?? "").trim().toLowerCase();
	return v === "1" || v === "true" || v === "on" || v === "yes";
}

/** EIGHT_NO_UPDATE_CHECK set to anything but empty, 0 or false turns the check off. */
export function updateCheckDisabled(env: Env, settingsFile?: string): boolean {
	const v = env.EIGHT_NO_UPDATE_CHECK?.trim().toLowerCase();
	if (v && v !== "0" && v !== "false") return true;
	if (settingsFile) {
		try {
			const s = JSON.parse(readFileSync(settingsFile, "utf8")) as { updateCheck?: unknown };
			if (s.updateCheck === false) return true;
		} catch {}
	}
	return false;
}

export interface NoticeDeps {
	now: () => number;
	readState: () => NoticeState | null;
	writeState: (s: NoticeState) => void;
	/** Newer version available? Null for none. */
	check: () => Promise<{ from: string; to: string } | null>;
	/** The id (version or sha) this install is at now, to drop a stale cached notice. */
	current: () => Promise<string | null>;
	disabled: () => boolean;
}

/** The notice line to show, or null. Never throws. */
export async function maybeUpdateNotice(d: NoticeDeps): Promise<string | null> {
	try {
		if (d.disabled()) return null;
		const st = d.readState();
		if (st && d.now() >= st.checkedAt && d.now() - st.checkedAt < CHECK_INTERVAL_MS) {
			if (!st.available) return null;
			const cur = await d.current();
			return cur && cur === st.available.from ? st.available.label : null;
		}
		let found: { from: string; to: string } | null = null;
		try {
			found = await d.check();
		} catch {
			found = null;
		}
		const label = found ? noticeText(found.from, found.to) : undefined;
		d.writeState({
			checkedAt: d.now(),
			available: found && label ? { ...found, label } : undefined,
		});
		return label ?? null;
	} catch {
		return null;
	}
}

export interface RealNoticeOptions {
	currentVersion: string;
	modulePath: string;
	embedded: boolean;
	env?: Env;
	platform?: string;
	arch?: string;
	fetchImpl?: FetchLike;
	exec?: ExecFn;
	settingsFile?: string;
	now?: () => number;
}

/** Wire maybeUpdateNotice to the real state file and the same checks `8gent update --check` uses. */
export function realNoticeDeps(o: RealNoticeOptions): NoticeDeps {
	const env = o.env ?? process.env;
	const platform = o.platform ?? process.platform;
	const stateFile = join(dataDir(env), "update-check.json");
	const channel = detectChannel({ modulePath: o.modulePath, embedded: o.embedded });
	const srcDeps = { modulePath: o.modulePath, env, platform, exec: o.exec };
	return {
		now: o.now ?? Date.now,
		disabled: () => !isUpdateCheckEnabled(env) || updateCheckDisabled(env, o.settingsFile),
		readState: () => {
			try {
				const s = JSON.parse(readFileSync(stateFile, "utf8")) as NoticeState;
				return typeof s.checkedAt === "number" ? s : null;
			} catch {
				return null;
			}
		},
		writeState: (s) => {
			try {
				mkdirSync(dataDir(env), { recursive: true });
				writeFileSync(stateFile, JSON.stringify(s), "utf8");
			} catch {}
		},
		check: async () => {
			if (channel === "source") {
				const r = await checkSourceAhead(srcDeps);
				return r ? { from: r.from.slice(0, 7), to: r.to.slice(0, 7) } : null;
			}
			const r = await checkUpdate({
				currentVersion: o.currentVersion,
				channel,
				fetchImpl: o.fetchImpl ?? (globalThis.fetch as unknown as FetchLike),
				platform,
				arch: o.arch ?? process.arch,
				releasesUrl: env.EIGHT_RELEASES_URL || undefined,
			});
			return r.status === "available" ? { from: r.from, to: r.to } : null;
		},
		current: async () => {
			if (channel !== "source") return o.currentVersion;
			const root = findCheckoutRoot(o.modulePath, platform);
			const git = resolveExecutable("git", { env, platform });
			if (!root || !git) return null;
			const r = await (o.exec ?? defaultExec)(git, ["rev-parse", "HEAD"], {
				cwd: root,
				timeoutMs: 15_000,
			});
			return r.code === 0 ? r.stdout.trim().slice(0, 7) : null;
		},
	};
}
