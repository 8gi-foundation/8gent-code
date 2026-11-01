/**
 * InlineApprovalPrompt tests - structural snapshot for the presentational
 * approval card.
 *
 * Follows the LilEightBadge / LiveFocalStrip pattern in this folder:
 * we use bun:test (no ink-testing-library available in the workspace)
 * and inspect the React element tree directly. InlineApprovalPrompt is
 * a pure function of props, so invoking it as a regular function is safe
 * and returns the rendered Box tree.
 */

import { describe, expect, test } from "bun:test";
import React from "react";
import { t } from "../../theme.js";
import {
	InlineApprovalPrompt,
	type InlineApprovalPromptProps,
	approvalCaps,
} from "../InlineApprovalPrompt";
import { keyCapText } from "../KeyCap";

const SHORT_TARGET = "write foo.ts";
const LONG_TARGET =
	"write /home/operator/8gent-code/apps/tui/src/components/very/deeply/nested/path/to/file/that/will/definitely/exceed/the/visible/width/of/the/inline/approval/card.ts";

function invoke(props: InlineApprovalPromptProps): React.ReactElement {
	// InlineApprovalPrompt is pure, so we can call it as a regular function
	// and inspect the returned React element directly.
	return (InlineApprovalPrompt as (p: InlineApprovalPromptProps) => React.ReactElement)(props);
}

describe("InlineApprovalPrompt", () => {
	test("exports the component and prop type", () => {
		expect(InlineApprovalPrompt).toBeDefined();
		expect(typeof InlineApprovalPrompt).toBe("function");
	});

	test("renders for a short target without crashing", () => {
		const element = React.createElement(InlineApprovalPrompt, { target: SHORT_TARGET });
		expect(element).toBeDefined();
		expect((element.props as InlineApprovalPromptProps).target).toBe(SHORT_TARGET);

		const rendered = invoke({ target: SHORT_TARGET });
		expect(rendered).toBeDefined();

		const props = rendered.props as {
			borderStyle: string;
			borderColor: string;
			paddingX: number;
			marginTop: number;
			flexShrink: number;
			justifyContent: string;
		};

		expect(props.borderStyle).toBe("round");
		expect(props.borderColor).toBe(t.orange);
		expect(props.paddingX).toBe(1);
		expect(props.marginTop).toBe(1);
		expect(props.flexShrink).toBe(0);
		expect(props.justifyContent).toBe("space-between");
	});

	test("renders for a long target (uses truncate-end on the target text)", () => {
		const rendered = invoke({ target: LONG_TARGET });
		expect(rendered).toBeDefined();

		// Walk into the left-hand Box to find the target <Text wrap="truncate-end">.
		const children = React.Children.toArray(
			(rendered.props as { children: React.ReactNode }).children,
		) as React.ReactElement[];
		const leftBox = children[0];
		expect(leftBox).toBeDefined();
		const leftChildren = React.Children.toArray(
			(leftBox.props as { children: React.ReactNode }).children,
		) as React.ReactElement[];
		// [<Text bold ASK> , <Text wrap="truncate-end">{target}</Text>]
		const targetText = leftChildren[1];
		const targetTextProps = targetText.props as {
			wrap?: string;
			color?: string;
			children: React.ReactNode;
		};
		expect(targetTextProps.wrap).toBe("truncate-end");
		expect(targetTextProps.color).toBe(t.textSecondary);
		expect(targetTextProps.children).toBe(LONG_TARGET);
	});

	test("snapshot of short and long targets is stable", () => {
		const summarize = (target: string) => {
			const rendered = invoke({ target });
			const props = rendered.props as {
				borderStyle: string;
				borderColor: string;
				paddingX: number;
				marginTop: number;
				flexShrink: number;
				justifyContent: string;
			};
			return {
				target,
				borderStyle: props.borderStyle,
				borderColor: props.borderColor,
				paddingX: props.paddingX,
				marginTop: props.marginTop,
				flexShrink: props.flexShrink,
				justifyContent: props.justifyContent,
			};
		};

		expect([summarize(SHORT_TARGET), summarize(LONG_TARGET)]).toMatchSnapshot();
	});
});

describe("approvalCaps", () => {
	const text = (w: number, gate = false) =>
		approvalCaps(w, gate)
			.map((c, i) => " ".repeat(i > 0 ? (c.gap ?? 0) : 0) + keyCapText(c.cap, c.verb))
			.join("");

	test("keeps the full verbs when the row fits", () => {
		expect(text(96)).toBe("[Y] approve  [N] deny  [E] edit  [S] skip");
	});

	test("never exceeds the width, down to a 36 cell card (40 columns)", () => {
		for (const w of [41, 38, 36, 35, 32]) expect(text(w).length).toBeLessThanOrEqual(w);
		expect(text(36)).toBe("[Y] yes  [N] no  [E] edit  [S] skip");
	});

	test("the yolo gate stays Y and N", () => {
		expect(text(36, true)).toBe("[Y] yes  [N] no");
	});
});
