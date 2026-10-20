import { afterEach, expect, test } from "bun:test";
import { Friction, enterFriction, leaveFriction, noteApproval } from "../eight/friction";
import {
	_resetTuiApprovalChannel,
	registerTuiApprovalHandler,
	requestTuiApproval,
	requestTuiDecision,
} from "./tui-approval-channel";

afterEach(() => {
	_resetTuiApprovalChannel();
});

test("a throwing friction tracker never changes the approval decision (#4511)", async () => {
	const broken = new Friction();
	broken.permission = () => {
		throw new Error("tracker broke");
	};
	const prev = enterFriction(broken);
	registerTuiApprovalHandler(async () => "deny");
	expect(await requestTuiDecision({ action: "a", details: "d" })).toBe("deny");
	registerTuiApprovalHandler(async () => "approve");
	expect(await requestTuiApproval({ action: "a", details: "d" })).toBe(true);
	leaveFriction(broken, prev);
});

const prompts = (f: Friction) => f.record().permissionPrompts;

test("a child turn inside a parent turn gets its prompt; the parent gets the next one back", () => {
	const [parent, child] = [new Friction(), new Friction()];
	const pp = enterFriction(parent);
	noteApproval("approve");
	const cp = enterFriction(child);
	noteApproval("approve");
	leaveFriction(child, cp);
	noteApproval("deny");
	leaveFriction(parent, pp);
	expect([prompts(parent), prompts(child)]).toEqual([2, 1]);
	noteApproval("approve");
	expect(prompts(parent)).toBe(2);
});

test("a child that never reaches cleanup does not keep the tracker", () => {
	const [parent, child] = [new Friction(), new Friction()];
	const pp = enterFriction(parent);
	const cp = enterFriction(child);
	leaveFriction(child, cp);
	noteApproval("approve");
	leaveFriction(parent, pp);
	expect([prompts(parent), prompts(child)]).toEqual([1, 0]);
});

test("two tabs taking turns each get their own prompts; skip and unfit are not counted", () => {
	const [a, b] = [new Friction(), new Friction()];
	for (const [f, n] of [
		[a, 2],
		[b, 1],
		[a, 1],
	] as const) {
		const prev = enterFriction(f);
		for (let i = 0; i < n; i++) noteApproval("approve");
		noteApproval("skip");
		noteApproval("unfit");
		leaveFriction(f, prev);
	}
	expect([prompts(a), prompts(b)]).toEqual([3, 1]);
});
