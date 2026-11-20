/**
 * #298: a read-only `cd <dir> && python3 -c '...json.load...'` was refused as
 * `verdict=block pYes=NaN backend=allowlist` with the audio lane's note
 * ("Audio is off for this session...") as the only reason. The audio lane's
 * quote-blind split read the Python subscript `d["train"]` as a glob command
 * word. The command now reaches the gate's defined path (rules-only in
 * default mode, a person in strict mode), and a block names the rule that fired.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import { AUDIO_REFUSAL, isAudioCommand } from "./s1-audio";
import {
	SYSTEM_ONE_FLAG,
	_resetSystemOne,
	_setSystemOneOverridesForTests,
	systemOneGate,
} from "./system-one-gate";

/** The command from the pilot run (2026-11-20_021403, sigi-dev-arc1-a, sequence 8). */
const PILOT_COMMAND = `cd /tmp/arc-work && python3 -c '
import json
d=json.load(open("task.json"))
for i,p in enumerate(d["train"]):
    inp=p["input"]; out=p["output"]
    # find which 3x3 blocks are filled (non-zero)
    blocks=[]
    for br in range(3):
        for bc in range(3):
            filled=True
            for r in range(3):
                for c in range(3):
                    if out[br*3+r][bc*3+c]!=0: filled=False
            if filled: blocks.append((br,bc))
    print(i, "filled blocks (row,col):", blocks)
'
`;

/** A judge that answers with no usable probability: pYes comes back NaN. */
class AnswersNaN implements DecideBackend {
	readonly name = "stub";
	readonly model = "stub-model";
	async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
		return {
			answers: [
				{
					id: request.questions[0].id,
					kind: "noul",
					probabilities: { yes: Number.NaN },
					confidence: 0,
				},
			],
			backend: this.name,
			model: this.model,
			latencyMs: 0,
		};
	}
}

let asked: string[] = [];
let home = "";

beforeEach(() => {
	asked = [];
	home = tempDir("s1-nan-298-home-");
	_setSystemOneOverridesForTests({
		createDecider: () => createDecider({ backend: new AnswersNaN(), cacheSize: 0 }),
		askHuman: async (req) => {
			asked.push(req.command);
			return true;
		},
		calibrationDir: tempDir("s1-nan-298-nocal-"),
	});
});

afterAll(() => {
	_resetSystemOne();
	cleanupTempDirs();
});

describe("#298 a NaN score never blocks a read-only python3 -c silently", () => {
	test("the audio lane does not read Python code inside python3 -c as shell words", () => {
		expect(isAudioCommand(PILOT_COMMAND)).toBe(false);
		// Still caught: a real audio program inside the code, and a glob a shell body would run.
		expect(isAudioCommand(`python3 -c 'import os; os.system("say hi")'`)).toBe(true);
		expect(isAudioCommand(`bash -c 'true; s[a]y hi'`)).toBe(true);
		expect(isAudioCommand("s[a]y hi")).toBe(true);
		expect(isAudioCommand(`python3 -c 'print(d["train"])'`)).toBe(false);
	});

	// 8SO review of PR #303: each of these bypassed the first fix and must stay refused.
	test.each([
		// 1. $'...' takes backslash escapes: \' does not close it.
		["ansi-c quote, variable", `python3 -c $'\\'' ; $CMD hi ; echo ''`],
		["ansi-c quote, glob", `python3 -c $'\\'' ; /usr/bin/sa[y] hi ; echo ''`],
		// 2. A quote inside an unquoted # comment opens nothing.
		["comment quote, variable", `python3 -c 'pass' #'\n$CMD hi\n#'`],
		["comment quote, glob", `python3 -c 'pass' #'\n/usr/bin/s?y hi\n#'`],
		// 3. The code body can hand a shell string to the shell.
		["python os.system glob", `python3 -c 'import os; os.system("/usr/bin/sa? hi")'`],
		["node execSync glob", `node -e 'require("child_process").execSync("/usr/bin/sa? hi")'`],
		["perl system glob", `perl -e 'system("/usr/bin/s[a]y hi")'`],
		// 4. A quoted argument to a script is not a -c/-e body.
		["script argument", `python3 script.py 'x; /usr/bin/sa? hi'`],
		["script argument variable", `python3 script.py 'x; $Y'`],
		// 8SO re-read at 8336ba9: a class opening with ] (sh reads []a] as "] or a").
		["code body, class opening with ]", `python3 -c 'import os; os.system("/usr/bin/s[]a]y hi")'`],
		["code body, negated ] class", `python3 -c 'import os; os.system("/usr/bin/s[!]x]y hi")'`],
		["code body, -ic flags", `python3 -ic 'import os; os.system("/usr/bin/s[]a]y hi")'`],
		[
			"node body, class opening with ]",
			`node -e 'require("child_process").execSync("/usr/bin/s[]a]y hi")'`,
		],
		// Negated and POSIX classes, at top level and inside a code body.
		["negated class !", "/usr/bin/s[!x]y hi"],
		["negated class ^", "/usr/bin/s[^x]y hi"],
		["posix class", "/usr/bin/s[[:alpha:]]y hi"],
		["code body, negated class !", `python3 -c 'import os; os.system("/usr/bin/s[!x]y hi")'`],
		["code body, negated class ^", `python3 -c 'import os; os.system("/usr/bin/s[^x]y hi")'`],
		["code body, posix class", `python3 -c 'import os; os.system("/usr/bin/s[[:alpha:]]y hi")'`],
		// 8SO read at 3ff4f11: sh expands a brace first, then globs each part, so a part
		// holding a glob or a nested brace can still name say.
		["code body, brace part ?", `python3 -c 'import os; os.system("/usr/bin/s{?,x}y hi")'`],
		["code body, brace part *", `python3 -c 'import os; os.system("/usr/bin/s{a*,x}y hi")'`],
		["code body, nested brace", `python3 -c 'import os; os.system("/usr/bin/s{a,{b,c}}y hi")'`],
		["node body, brace part ?", `node -e 'require("child_process").execSync("/usr/bin/s{?,x}y hi")'`],
		["perl body, brace part class", `perl -e 'system("/usr/bin/s{[a],x}y hi")'`],
	])("still refused: %s", (_name, command) => {
		expect(isAudioCommand(command)).toBe(true);
	});

	test("default mode: no usable score falls to the rules-only path and runs", async () => {
		const r = await systemOneGate(PILOT_COMMAND, { HOME: home });
		expect(r.guard?.verdict).not.toBe("block");
		expect(r.guard?.backend).toBe("rules-only");
		expect(r.run).toBe(true);
	});

	test("strict mode: a NaN score goes to a person, never a silent block", async () => {
		const r = await systemOneGate(PILOT_COMMAND, { HOME: home, [SYSTEM_ONE_FLAG]: "1" });
		expect(r.guard?.verdict).not.toBe("block");
		expect(asked.length).toBe(1);
		expect(r.run).toBe(true);
	});
});

describe("#298 a System One block names the rule that fired", () => {
	test("the audio refusal says it is the audio rule, not only the session note", async () => {
		const r = await systemOneGate('say "hi"', { HOME: home, [SYSTEM_ONE_FLAG]: "1" });
		expect(r.run).toBe(false);
		expect(r.guard?.rule).toBe("audio");
		expect(r.message).toContain("rule=audio");
		expect(r.message).toContain(AUDIO_REFUSAL);
	});
});
