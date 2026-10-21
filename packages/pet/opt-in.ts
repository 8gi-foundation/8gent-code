/**
 * Lil Eight is an opt-in extension. Nothing starts, prints or installs it
 * unless the user asks: `8gent --pet` for one run, or `8gent pet` / `/pet`.
 * No config file, env var or first run state can switch it on by itself.
 */
export function petRequested(args: readonly string[]): boolean {
	return args.includes("--pet") && !args.includes("--no-pet");
}
