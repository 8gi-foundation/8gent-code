/**
 * The EIGHT_DURABLE_RUN switch, alone in a module with no imports: `8gent durable-run` reads it
 * before anything else is loaded, so a refused run loads none of Pi Durable or its provider SDKs.
 */
export function durableRunEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return env.EIGHT_DURABLE_RUN === "1";
}
