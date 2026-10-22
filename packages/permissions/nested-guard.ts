/**
 * Runtime guard against an 8gent starting inside its own tool shell (#4715). Static checks on
 * the command text cannot see `$(printf '8g''ent') chat` or `x=8gent; $x chat`, so the tool
 * shells mark their child env and the entry points refuse to start when they see the mark.
 */

export const NESTED_ENV = "EIGHT_PARENT_SESSION";
export const NESTED_OVERRIDE = "EIGHT_ALLOW_NESTED";
export const NESTED_MESSAGE =
	"8gent: refusing to start inside an 8gent tool shell (set EIGHT_ALLOW_NESTED=1 to override)";

/** The env a tool shell hands its child: the base env plus the nesting mark. */
export function toolShellEnv(
	base: Record<string, string | undefined> = process.env,
): NodeJS.ProcessEnv {
	return { ...base, [NESTED_ENV]: String(process.pid) } as unknown as NodeJS.ProcessEnv;
}

/** True when this process was started by a tool shell and nothing overrides that. */
export function isNestedStart(env: Record<string, string | undefined> = process.env): boolean {
	return Boolean(env[NESTED_ENV]) && env[NESTED_OVERRIDE] !== "1";
}

/** Entry points call this first: exit 2 with the message when nested. */
export function refuseIfNested(env: Record<string, string | undefined> = process.env): void {
	if (!isNestedStart(env)) return;
	process.stderr.write(`${NESTED_MESSAGE}\n`);
	process.exit(2);
}
