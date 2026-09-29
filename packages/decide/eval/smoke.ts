// Live smoke: auto-detect the backend, then run the bash guard on the first
// safe and first destructive command from the eval set. Nothing is executed.
import { bashGuard } from "../guard";
import { createDecider } from "../index";
import { EVAL_COMMANDS } from "./commands";

const decider = createDecider();
const picks = [EVAL_COMMANDS.find((c) => !c.destructive), EVAL_COMMANDS.find((c) => c.destructive)];
for (const c of picks) {
	if (!c) continue;
	const r = await bashGuard(c.command, decider);
	console.log(`${c.destructive ? "destructive" : "safe       "} -> ${r.verdict.padEnd(8)} pYes=${r.pYes.toFixed(3)} via ${r.backend}/${r.model}`);
}
