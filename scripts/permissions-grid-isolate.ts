/**
 * Isolation for the grid's shell probe (#4509). The probe runs only under verified isolation, else
 * not at all. Both mechanisms jail WRITES to the scratch dir and are proven by a canary before use:
 * a write outside scratch must fail and one inside must succeed. Nothing here is a guarantee on its
 * own; the stubs, the rc-free flags and the row skips in permissions-grid.ts are the other layers.
 *
 * Linux: unshare user+mount namespace, every mount read-only, scratch rebound read-write, then each
 * system bin dir replaced by the stub dir. Every step fails closed by touching a secret sentinel
 * file (never by an exit code a row could fake). macOS: sandbox-exec, deny-default, writes only
 * under scratch, no network, a narrow mach-lookup list, and a launchctl/osascript escape canary.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Iso {
	name: string;
	wrap: (argv: string[]) => [string, string[]];
	lost: () => boolean;
}

/** Write outside scratch must fail, write inside must succeed. */
function writeCanary(
	wrap: Iso["wrap"],
	scratch: string,
	extra: () => boolean = () => true,
): boolean {
	const outside = mkdtempSync(join(tmpdir(), "grid-outside-"));
	try {
		spawnSync(...wrap(["/bin/sh", "-c", `echo x > "${outside}/c"; echo y > "${scratch}/in"`]), {
			stdio: "ignore",
		});
		return !existsSync(join(outside, "c")) && existsSync(join(scratch, "in")) && extra();
	} finally {
		rmSync(outside, { recursive: true, force: true });
	}
}

export function isolate(scratch: string, stubs: string, sh: string): Iso | null {
	if (process.platform === "linux") {
		const unshare = Bun.which("unshare");
		if (!unshare) return null;
		const sentinel = join(scratch, `.cover-failed-${randomUUID()}`);
		const dirs = "/usr/bin /usr/sbin /usr/local/bin /usr/local/sbin /sbin /bin";
		// The row runs with no capabilities: root in a user namespace could undo the mounts below.
		const drop =
			'D="$S/unshare --user --mount --"; [ -x "$S/unshare" ] || D="$S/setpriv --no-new-privs --inh-caps=-all --ambient-caps=-all --bounding-set=-all --"; [ -x "${D%% *}" ] || die;';
		const canary = `$D "$S/sh" -c '"$0/mount" -o remount,rw / 2>/dev/null && exit 1; "$0/umount" /usr/bin 2>/dev/null && exit 1; exit 0' "$S" || die;`;
		const cover = [
			// fd 9 is the sentinel, opened while scratch is still writable; a row never sees it (closed before exec)
			'S=$1; F=$2; R=$3; shift 3; exec 9>>"$F"; die() { echo lost >&9; exit 97; };',
			'L=$(while read -r _ _ _ _ m _; do echo "$m"; done < /proc/self/mountinfo);',
			'for m in $L; do "$S/mount" -o remount,bind,ro "$m" || die; done;',
			'while read -r _ _ _ _ m o _; do case "$o" in ro|ro,*) ;; *) [ "$m" = /dev/null ] || die;; esac; done < /proc/self/mountinfo;',
			'"$S/mount" --bind "$R" "$R" && "$S/mount" -o remount,bind,rw "$R" || die;',
			`for d in ${dirs}; do if [ -d "$d" ] && [ ! -L "$d" ]; then "$S/mount" --bind "$S" "$d" || die; fi; done;`,
			'[ "$(command -v rm)" = "$S/rm" ] && [ "$(/usr/bin/rm .)" = "RAN rm ." ] || die;',
			drop,
			canary,
			'exec 9>&-; exec $D "$@"',
		].join(" ");
		const wrap: Iso["wrap"] = (argv) => [
			unshare,
			[
				"--user",
				"--map-root-user",
				"--mount",
				sh,
				"-c",
				cover,
				"grid",
				stubs,
				sentinel,
				scratch,
				...argv,
			],
		];
		const lost = () => existsSync(sentinel) && statSync(sentinel).size > 0;
		return writeCanary(wrap, scratch, () => !lost())
			? { name: "unshare mount namespace", wrap, lost }
			: null;
	}
	if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) return null;
	// Unverified where this was written (the session was itself sandboxed): the mach list is the
	// narrow starting set; the canary below fails closed if bash or zsh cannot start under it.
	const profile = [
		"(version 1)(deny default)(allow process*)(allow file-read*)(deny network*)",
		`(allow file-write* (subpath "${scratch}"))(allow file-write* (literal "/dev/null"))`,
		'(allow sysctl-read)(allow signal (target self))(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.logger") (global-name "com.apple.system.notification_center"))',
	].join("");
	const wrap: Iso["wrap"] = (argv) => ["/usr/bin/sandbox-exec", ["-p", profile, ...argv]];
	const lc = `gridcanary-${randomUUID()}`;
	const noEscape = () => {
		const marker = join(scratch, "launchd-escaped");
		const osa = spawnSync(...wrap(["/usr/bin/osascript", "-e", 'do shell script "true"']), {
			stdio: "ignore",
		});
		spawnSync(...wrap(["/bin/launchctl", "submit", "-l", lc, "--", "/usr/bin/touch", marker]), {
			stdio: "ignore",
		});
		Bun.sleepSync(500);
		spawnSync("/bin/launchctl", ["remove", lc], { stdio: "ignore" }); // outside the profile, in case submit worked
		return osa.status !== 0 && !existsSync(marker);
	};
	return writeCanary(wrap, scratch, noEscape)
		? { name: "sandbox-exec", wrap, lost: () => false }
		: null;
}
