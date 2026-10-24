/**
 * `8gent scout add | list | run | enable | disable | remove` (#4926).
 *
 * add and enable show every address and ask once, defaulting to No; with nobody to ask
 * (CI, EIGHT_UNATTENDED, no terminal) the answer is no and nothing is saved or turned on.
 */

import type { RoutineManager } from "./routines";
import { type Ask, ScoutError, defaultAsk, scoutDir } from "./scout";

export interface ScoutCliDeps {
	manager: RoutineManager;
	env?: Record<string, string | undefined>;
	say?: (line: string) => void;
	ask?: Ask;
}

const USAGE =
	'Usage: 8gent scout add <name> --schedule "<cron>" --source <id>=<https url> [--source ...] [--keyword <word> ...]\n       8gent scout list | run <id> | enable <id> | disable <id> | remove <id>';

function parseAdd(args: string[]) {
	const [name, ...rest] = args;
	if (!name || name.startsWith("--")) throw new ScoutError("a scout needs a name");
	let schedule = "";
	const sources: { id: string; url: string }[] = [];
	const keywords: string[] = [];
	for (let i = 0; i < rest.length; i += 2) {
		const flag = rest[i];
		const val = rest[i + 1];
		if (val === undefined) throw new ScoutError(`${flag} needs a value`);
		if (flag === "--schedule") schedule = val;
		else if (flag === "--keyword") keywords.push(val);
		else if (flag === "--source") {
			const eq = val.indexOf("=");
			if (eq < 1)
				throw new ScoutError(`--source is <id>=<url>, got ${JSON.stringify(val.slice(0, 60))}`);
			sources.push({ id: val.slice(0, eq), url: val.slice(eq + 1) });
		} else throw new ScoutError(`unknown option ${flag}`);
	}
	if (!schedule) throw new ScoutError("a scout needs --schedule");
	return { name, schedule, sources, keywords };
}

/** Returns the exit code. */
export async function runScoutCommand(args: string[], deps: ScoutCliDeps): Promise<number> {
	const say = deps.say ?? ((l: string) => console.log(l));
	const env = deps.env ?? process.env;
	const ask = deps.ask ?? defaultAsk(env);
	const m = deps.manager;
	const [sub, ...rest] = args;
	const scouts = () => m.list().filter((r) => r.kind === "scout");
	try {
		if (sub === "add") {
			const opts = parseAdd(rest);
			const r = await m.createScout(opts, ask);
			if (!r) {
				say("Not enabled: nothing was saved and nothing was fetched.");
				return 1;
			}
			say(
				`Saved scout ${r.id} (${r.name}), schedule "${r.schedule}". Results go to ${scoutDir(env, r.id)}.`,
			);
			return 0;
		}
		if (sub === "list" || sub === undefined) {
			const list = scouts();
			if (list.length === 0) say("No scouts. Add one with: 8gent scout add");
			for (const r of list)
				say(
					`${r.id}  ${r.enabled ? "on " : "off"}  "${r.schedule}"  ${r.name}  (${r.scout?.sources.length ?? 0} sources)`,
				);
			return 0;
		}
		const id = rest[0];
		const found = id ? scouts().find((r) => r.id === id) : undefined;
		if (sub === "run" || sub === "enable" || sub === "disable" || sub === "remove") {
			if (!found) {
				say(`No scout ${id ?? ""}. See: 8gent scout list`);
				return 1;
			}
			if (sub === "disable") {
				m.disable(found.id);
				say(`Turned off ${found.id}. Turning it on again asks again.`);
				return 0;
			}
			if (sub === "remove") {
				m.delete(found.id);
				say(`Removed ${found.id}. Its result files stay in ${scoutDir(env, found.id)}.`);
				return 0;
			}
			if (sub === "enable") {
				const ok = await m.enableScout(found.id, ask);
				say(ok ? `Turned on ${found.id}.` : "Not enabled: it stays off.");
				return ok ? 0 : 1;
			}
			const run = await m.trigger(found.id, "manual");
			if (!run) return 1;
			say(
				run.status === "completed"
					? `Done. Result: ${run.output}`
					: `Failed: ${run.error ?? "see the result file"}${run.output ? ` (${run.output})` : ""}`,
			);
			return run.status === "completed" ? 0 : 1;
		}
		say(USAGE);
		return 1;
	} catch (err) {
		say(err instanceof Error ? err.message : String(err));
		if (err instanceof ScoutError) say(USAGE);
		return 1;
	}
}
