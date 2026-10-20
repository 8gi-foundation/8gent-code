import { afterEach, expect, test } from "bun:test";
import { type Friction, _setActiveFriction } from "../eight/friction";
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
