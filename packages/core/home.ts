import { homedir as osHomedir } from "node:os";

/**
 * Resolve the user's home directory, preferring an explicit environment
 * override over the OS lookup.
 *
 * The problem this solves: the product has ~180 call sites that each roll
 * their own fallback chain - `process.env.HOME || process.env.USERPROFILE ||
 * ""`, `process.env.HOME || "~"`, `${process.env.HOME}/.8gent/...`. With HOME
 * unset (the normal state on Windows) those degrade to a cwd-relative path, a
 * literal `~` directory, or the string "undefined/..." - all of which have
 * been observed writing to disk. Meanwhile the sites that call os.homedir()
 * cannot be sandboxed at all on Windows, because bun's os.homedir() reads
 * USERPROFILE and ignores HOME, and vice versa for the chain sites. Neither
 * variable alone redirects the product, so a single resolver that consults
 * both is the only way to make it sandboxable.
 *
 * Precedence is deliberately platform-aware so this is a pure fix: no existing
 * install moves.
 *
 *   EIGHT_HOME > (win32: USERPROFILE > HOME) | (other: HOME) > os.homedir()
 *
 * EIGHT_HOME is the unambiguous switch - it cannot collide with a HOME that a
 * POSIX-emulation shell (git-bash, MSYS, cygwin) may have exported.
 *
 * Note: on win32 os.homedir() itself resolves USERPROFILE before HOME and
 * falls back to the registry, so preferring USERPROFILE here matches the
 * current behaviour exactly for every unmodified call site.
 */

/**
 * The environment variables `resolveHome` consults, declared explicitly so a
 * caller (and a test) can pass a partial environment without having to fake
 * the whole of `process.env`. `process.env` satisfies this structurally.
 */
export type HomeEnv = {
  EIGHT_HOME?: string | undefined;
  USERPROFILE?: string | undefined;
  HOME?: string | undefined;
  // The index signature is what makes `process.env` assignable here: it is the
  // only property TypeScript can match against ProcessEnv's own index
  // signature. Without it the assignment fails under weak-type detection
  // (TS2559) even though every declared key is optional.
  [key: string]: string | undefined;
};

export function resolveHome(
  env: HomeEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.EIGHT_HOME) return env.EIGHT_HOME;
  if (platform === "win32") return env.USERPROFILE || env.HOME || osHomedir();
  return env.HOME || osHomedir();
}
