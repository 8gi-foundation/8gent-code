/**
 * 8gent Code - a new file outside the folder the work is going into (#3580).
 *
 * In pilot run 2026-10-06_201858/media-brief-video the request said "put
 * everything in video/". The model wrote video/slides.md and
 * video/narration.txt, then a new build_video.sh in the top folder, and the
 * write said only "File written". The system prompt already says not to
 * create files in the root when the work lives in a subdirectory; this line
 * says it at the moment it happens.
 *
 * Rule: a write that creates a new file directly in the working directory,
 * when at least two files this session created before it all sit under one
 * top-level folder, gets one line naming that folder. Writes into folders,
 * rewrites of existing files and sessions with no clear work folder get
 * nothing. The record is keyed off the session's CreatedFiles, so it lives
 * and dies with the session and needs no change to that security record.
 */

import * as path from "node:path";
import type { CreatedFiles } from "../permissions/s1-created-files";

const MIN_PRIOR = 2;
const created = new WeakMap<CreatedFiles, string[]>();

/**
 * Note a write and return the scope line for it, or "". `wasNew` is whether
 * the path existed before the write. Paths outside the working directory are
 * ignored.
 */
export function writeScopeLine(
	session: CreatedFiles | undefined,
	workingDirectory: string,
	absolutePath: string,
	wasNew: boolean,
): string {
	if (!session || !wasNew) return "";
	const rel = path.relative(path.resolve(workingDirectory), path.resolve(absolutePath));
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return "";
	const prior = created.get(session) ?? [];
	created.set(session, [...prior, rel]);
	if (rel.includes(path.sep) || prior.length < MIN_PRIOR) return "";
	const folders = new Set(prior.map((p) => (p.includes(path.sep) ? p.split(path.sep)[0] : "")));
	if (folders.size !== 1) return "";
	const [folder] = folders;
	if (!folder) return "";
	return `Scope: ${rel} is a new file in the top folder, but every other file you created is in ${folder}/. If the request put the work in ${folder}/, write it there instead (helper scripts too) and remove this one.`;
}
