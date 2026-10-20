import { afterEach, expect, test } from "bun:test";
import {
	Friction,
	_setActiveFriction,
	adoptFriction,
	noteApproval,
	releaseFriction,
} from "../eight/friction";
import {
	_resetTuiApprovalChannel,
	registerTuiApprovalHandler,
	requestTuiApproval,
	requestTuiDecision,
} from "./tui-approval-channel";

afterEach(() => {
	_resetTuiApprovalChannel();
	_setActiveFriction(null);
});

test("a throwing friction tracker never changes the approval decision (#4511)", async () => {
	_setActiveFriction({
		permission() {
			throw new Error("tracker broke");
		},
	} as unknown as Friction);
	registerTuiApprovalHandler(async () => "deny");
	expect(await requestTuiDecision({ action: "a", details: "d" })).toBe("deny");
	registerTuiApprovalHandler(async () => "approve");
	expect(await requestTuiApproval({ action: "a", details: "d" })).toBe(true);
});

test("the newest session gets the counts; release hands the channel on; skip and unfit are not counted", () => {
	const [one, two, three] = [new Friction(), new Friction(), new Friction()];
	adoptFriction(one);
	adoptFriction(two);
	noteApproval("approve");
	noteApproval("skip");
	noteApproval("unfit");
	expect([one.record().permissionPrompts, two.record().permissionPrompts]).toEqual([0, 1]);
	releaseFriction(one);
	noteApproval("deny");
	expect(two.record().permissionDenials).toBe(1);
	releaseFriction(two);
	noteApproval("approve");
	expect(two.record().permissionPrompts).toBe(2);
	adoptFriction(three);
	noteApproval("edit");
	expect(three.record().permissionPrompts).toBe(1);
});
