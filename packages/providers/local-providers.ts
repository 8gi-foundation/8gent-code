/**
 * The one list of providers whose inference runs ON-BOX. packages/eight
 * (registry.ts LOCAL_PROVIDERS) and packages/providers (model-reroute.ts)
 * both read it, so "local" cannot mean two things. No imports, so neither
 * side can form a cycle through it.
 *
 * packages/permissions/command-policy.ts still holds its own copy; it is the
 * permissions class and moves in a separate reviewed change.
 */
export const LOCAL_PROVIDERS: ReadonlySet<string> = new Set([
	"8gent",
	"ollama",
	"lmstudio",
	"llama-server",
	"apfel",
	"apple-foundation",
]);

/** True when `name` is an on-box provider/runtime. */
export function isLocalProvider(name: string): boolean {
	return LOCAL_PROVIDERS.has(name);
}
