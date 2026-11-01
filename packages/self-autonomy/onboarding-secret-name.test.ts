/**
 * A key typed where onboarding asks for a name is refused, never saved (#5098).
 * Driven through processAnswer, the entry the TUI calls for every answer.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadSettings } from "../settings/index.js";
import { OnboardingManager, type OnboardingStep } from "./onboarding";

const KEY = "sk-ant-api03-AbCdEf1234567890AbCdEf1234567890";
const NAME_STEPS: OnboardingStep[] = [
	"identity",
	"agent-name-orchestrator",
	"agent-name-engineer",
	"agent-name-qa",
	"voice",
];

let home: string;
let prevHome: string | undefined;
let prevEight: string | undefined;

beforeAll(() => {
	prevHome = process.env.HOME;
	prevEight = process.env.EIGHT_HOME;
	home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "8gent-secret-name-")));
	process.env.HOME = home;
	process.env.EIGHT_HOME = home;
});

afterAll(() => {
	process.env.HOME = prevHome;
	if (prevEight === undefined) delete process.env.EIGHT_HOME;
	else process.env.EIGHT_HOME = prevEight;
	fs.rmSync(home, { recursive: true, force: true });
});

function managerAt(step: OnboardingStep): OnboardingManager {
	fs.rmSync(path.join(home, ".8gent"), { recursive: true, force: true });
	const m = new OnboardingManager(home);
	for (let i = 0; i < 40 && m.getNextQuestion()?.step !== step; i++) m.skipQuestion();
	expect(m.getNextQuestion()?.step).toBe(step);
	return m;
}

function everythingOnDisk(): string {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else out.push(fs.readFileSync(p, "utf-8"));
		}
	};
	walk(home);
	return out.join("\n");
}

describe("onboarding name steps refuse a key", () => {
	for (const step of NAME_STEPS) {
		test(`${step}: key refused, same question again, nothing saved`, () => {
			const m = managerAt(step);
			const refusal = m.refuseSecretName(KEY);
			expect(refusal).toContain("/apikeys");
			expect(refusal).not.toContain(KEY);
			const r = m.processAnswer(KEY);
			expect(r.success).toBe(false);
			expect(r.nextQuestion?.step).toBe(step);
			expect(everythingOnDisk()).not.toContain(KEY);
			expect(JSON.stringify(m.getUser())).not.toContain(KEY);
		});
	}

	test("a name step still takes a normal name afterwards", () => {
		const m = managerAt("agent-name-orchestrator");
		expect(m.processAnswer(KEY).success).toBe(false);
		expect(m.processAnswer("Plato").success).toBe(true);
		expect(loadSettings().agents.names.orchestrator).toBe("Plato");
	});

	test("names with spaces, accents and emoji still save", () => {
		for (const [step, name] of [
			["identity", "Mary Jane O'Neil"],
			["agent-name-engineer", "Zoë 🙂"],
			["voice", "Eight"],
		] as const) {
			const m = managerAt(step);
			expect(m.refuseSecretName(name)).toBeNull();
			expect(m.processAnswer(name).success).toBe(true);
			if (step === "agent-name-engineer") {
				expect(loadSettings().agents.names.engineer).toBe(name);
			}
			if (step === "identity") expect(m.getUser().identity.name).toBe(name);
		}
	});

	test("a step that is not a name does not refuse", () => {
		const m = managerAt("role");
		expect(m.refuseSecretName(KEY)).toBeNull();
	});

	test("the chat's name question does not store a key", () => {
		fs.rmSync(path.join(home, ".8gent"), { recursive: true, force: true });
		const m = new OnboardingManager(home);
		expect(m.answerNameClarification(KEY)).toBeNull();
		expect(everythingOnDisk()).not.toContain(KEY);
	});
});
