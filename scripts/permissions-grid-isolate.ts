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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
		const cover = [
			'S=$1; F=$2; R=$3; shift 3; die() { : > "$F"; exit 97; };',
			'while read -r _ _ _ _ m _; do "$S/mount" -o remount,bind,ro "$m" 2>/dev/null; done < /proc/self/mountinfo;',
			'"$S/mount" --bind "$R" "$R" && "$S/mount" -o remount,bind,rw "$R" || die;',
			`for d in ${dirs}; do if [ -d "$d" ] && [ ! -L "$d" ]; then "$S/mount" --bind "$S" "$d" || die; fi; done;`,
			'[ "$(command -v rm)" = "$S/rm" ] && [ "$(/usr/bin/rm .)" = "RAN rm ." ] || die; exec "$@"',
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
		const lost = () => existsSync(sentinel);
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
