import { afterEach, expect, test } from "bun:test";
import { Friction, noteApproval, withFriction } from "../eight/friction";
import {
	_resetTuiApprovalChannel,
	registerTuiApprovalHandler,
	requestTuiApproval,
	requestTuiDecision,
} from "./tui-approval-channel";

afterEach(() => {
	_resetTuiApprovalChannel();
});

const prompts = (f: Friction) => f.record().permissionPrompts;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("a throwing friction tracker never changes the approval decision (#4511)", async () => {
	const broken = new Friction();
	broken.permission = () => {
		throw new Error("tracker broke");
	};
	await withFriction(broken, async () => {
		registerTuiApprovalHandler(async () => "deny");
		expect(await requestTuiDecision({ action: "a", details: "d" })).toBe("deny");
		registerTuiApprovalHandler(async () => "approve");
		expect(await requestTuiApproval({ action: "a", details: "d" })).toBe(true);
	});
});

test("a child turn inside a parent turn gets its prompt; the parent gets the next one back", () => {
	const [parent, child] = [new Friction(), new Friction()];
	withFriction(parent, () => {
		noteApproval("approve");
		withFriction(child, () => noteApproval("approve"));
		noteApproval("deny");
	});
	expect([prompts(parent), prompts(child)]).toEqual([2, 1]);
});

test("a child that never finishes keeps nothing of the parent's", () => {
	const [parent, child] = [new Friction(), new Friction()];
	withFriction(parent, () => {
		withFriction(child, () => {});
		noteApproval("approve");
	});
	expect([prompts(parent), prompts(child)]).toEqual([1, 0]);
});

test("interleaved turns: each async chain counts to its own tracker", async () => {
	const [a, b] = [new Friction(), new Friction()];
	const turnA = withFriction(a, async () => {
		noteApproval("approve");
		await tick(20);
		noteApproval("approve");
	});
	const turnB = withFriction(b, async () => {
		await tick(5);
		noteApproval("approve");
		await tick(5);
		noteApproval("deny");
	});
	await Promise.all([turnA, turnB]);
	expect([prompts(a), prompts(b)]).toEqual([2, 2]);
});

test("skip and unfit are not counted, and a prompt outside any turn counts nowhere", () => {
	const f = new Friction();
	withFriction(f, () => {
		noteApproval("skip");
		noteApproval("unfit");
	});
	noteApproval("approve");
	expect(prompts(f)).toBe(0);
});
