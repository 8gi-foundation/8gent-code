/**
 * Optional guard for tool-call arguments, behind EIGHT_SCHEMA_CHECK=1 exactly.
 * A rejection is logged, never thrown, and the call still runs: this slice
 * measures what the model sends, it does not block it. A tool whose schema
 * uses a keyword outside slice 1 is skipped once and not checked.
 */
import { type Compiled, compile } from "./index";

const MAX_SHOWN = 20;
const MAX_LINE = 2000;

export const schemaCheckOn = (): boolean => process.env.EIGHT_SCHEMA_CHECK === "1";

type Def = { function?: { name?: unknown; parameters?: unknown } };

export class ToolArgGuard {
	private compiled: Map<string, Compiled | null> | null = null;

	constructor(
		private readonly defs: () => object[],
		private readonly log: (line: string) => void = (l) => console.warn(l),
	) {}

	private load(): Map<string, Compiled | null> {
		const out = new Map<string, Compiled | null>();
		for (const d of this.defs() as Def[]) {
			const name = d.function?.name;
			if (typeof name !== "string" || d.function?.parameters === undefined) continue;
			try {
				out.set(name, compile(d.function.parameters));
			} catch (err) {
				out.set(name, null);
				this.log(`[schema-check] tool=${name} skipped: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		return out;
	}

	/** Problems found, empty when the args pass or the tool has no checkable schema. */
	problems(toolName: string, args: unknown): string[] {
		this.compiled ??= this.load();
		const c = this.compiled.get(toolName);
		return c ? c.errors(args) : [];
	}

	/** One bounded, control-free log line: first MAX_SHOWN problems, then a count. */
	private line(toolName: string, bad: string[]): string {
		const shown = bad.slice(0, MAX_SHOWN).join("; ");
		const more = bad.length > MAX_SHOWN ? `; and ${bad.length - MAX_SHOWN} more` : "";
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
		const text = `[schema-check] tool=${toolName} rejected: ${shown}${more}`.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
		return text.length > MAX_LINE ? `${text.slice(0, MAX_LINE - 3)}...` : text;
	}

	/** Log a rejection. Never throws. */
	observe(toolName: string, args: unknown): void {
		if (!schemaCheckOn()) return;
		try {
			const bad = this.problems(toolName, args);
			if (bad.length > 0) this.log(this.line(toolName, bad));
		} catch {
			// A guard that fails must never take a tool call with it.
		}
	}
}
