/**
 * Atomic file replace, shared by the permission config (#4818) and the denial
 * ledger: temp file in the target's own directory, fsync, rename over the
 * target. A crash or a concurrent reader never sees a partial file. A symlink
 * stays a link (the real target is replaced) and an existing mode is kept.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export function writeFileAtomic(target: string, text: string, defaultMode = 0o600): void {
	let mode = defaultMode;
	try {
		target = fs.realpathSync(target);
		mode = fs.statSync(target).mode & 0o777;
	} catch {
		// New file: default mode, write at the given path.
	}
	const tmp = path.join(
		path.dirname(target),
		`.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
	);
	const fd = fs.openSync(tmp, "wx", mode);
	try {
		fs.writeFileSync(fd, text);
		fs.fsyncSync(fd);
	} catch (err) {
		fs.closeSync(fd);
		fs.rmSync(tmp, { force: true });
		throw err;
	}
	fs.closeSync(fd);
	try {
		fs.chmodSync(tmp, mode);
		fs.renameSync(tmp, target);
	} catch (err) {
		fs.rmSync(tmp, { force: true });
		throw err;
	}
}
