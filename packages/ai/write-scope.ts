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
 * when at least two files this session created before it with write_file all
 * share one folder, gets one line naming that folder. It stays quiet for
 * files that belong in a root (configs, manifests, dotfiles, docs), for
 * conventional code roots (src/, lib/, packages/, apps/, tests/), for
 * rewrites, for writes into folders, and when there is no single work
 * folder. The record is keyed off the session's CreatedFiles, so it lives
 * and dies with the session and needs no change to that security record.
 */

import * as path from "node:path";
import type { CreatedFiles } from "../permissions/s1-created-files";

const MIN_PRIOR = 2;
/** Per session: how many files were created, and the deepest folder they all share. null once they share none. */
const created = new WeakMap<CreatedFiles, { count: number; folder: string } | null>();

/** Files that conventionally live at a project root: never asked to move. */
const ROOT_FILE =
	/^(\..*|.*\.config\.[a-z]+|package(-lock)?\.json|tsconfig.*\.json|jsconfig.*\.json|(readme|changelog|license|licence|contributing|security|notice|authors)(\..*)?|dockerfile.*|docker-compose.*|compose\.ya?ml|makefile|justfile|procfile|pyproject\.toml|setup\.(py|cfg)|requirements.*\.txt|cargo\.(toml|lock)|go\.(mod|sum)|gemfile(\.lock)?|.*\.lock|.*\.lockb|biome\.jsonc?|vercel\.json|netlify\.toml|fly\.toml|wrangler\.(toml|jsonc?))$/i;

/** Folders where code lives in any repo: not a folder the user scoped work to. */
const CODE_ROOTS = new Set([
	"src",
	"lib",
	"packages",
	"apps",
	"app",
	"test",
	"tests",
	"spec",
	"scripts",
]);

/** The deepest folder both `a` and `b` sit in ("" for the top folder). */
function sharedFolder(a: string, b: string): string {
	const x = a.split(path.sep);
	const y = b.split(path.sep);
	const shared: string[] = [];
	for (let i = 0; i < x.length && x[i] === y[i] && x[i] !== "."; i++) shared.push(x[i]);
	return shared.join(path.sep);
}

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
	const state = created.has(session) ? created.get(session) : { count: 0, folder: "" };
	// null: the files share no folder, and more files can never give them one.
	if (!state) return "";
	const folder = state.count >= MIN_PRIOR ? state.folder : "";
	const dir = path.dirname(rel);
	const next = state.count === 0 ? (dir === "." ? "" : dir) : sharedFolder(state.folder, dir);
	created.set(session, next ? { count: state.count + 1, folder: next } : null);
	if (rel.includes(path.sep) || !folder || ROOT_FILE.test(rel)) return "";
	if (CODE_ROOTS.has(folder.split(path.sep)[0])) return "";
	// Shown to the model: forward slashes on every platform.
	const shown = folder.split(path.sep).join("/");
	const target = `${shown}/${rel}`;
	return `Scope: ${rel} is a new file in the top folder, but every other file you have created with write_file is in ${shown}/. If the request put the work in ${shown}/, write it as ${target} instead, then delete the top-folder copy.`;
}
