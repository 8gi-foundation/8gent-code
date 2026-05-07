/**
 * ContextRail tests - structural snapshot across risk levels and ADHD modes.
 *
 * Mirrors the LilEightBadge.test.tsx pattern: bun:test, no ink-testing-library,
 * inspect the React element tree directly. ContextRail is a pure function of
 * props so we can invoke it without a renderer and assert on the produced
 * structure.
 */

import { describe, expect, test } from "bun:test";
import React from "react";
import { ContextRail, type ContextRailProps } from "../ContextRail";
import { t } from "../../theme.js";

type Risk = ContextRailProps["risk"];

const RISKS: Risk[] = ["low", "medium", "high"];

const expectedRiskColor: Record<Risk, string> = {
	low:    t.green,
	medium: t.orange,
	high:   t.red,
};

const baseProps: ContextRailProps = {
	branch: "feat/tui-context-rail",
	risk: "low",
	permissions: "ask",
	contextPct: 42,
	adhdMode: false,
};

function render(props: ContextRailProps): React.ReactElement {
	return (ContextRail as (p: ContextRailProps) => React.ReactElement)(props);
}

describe("ContextRail", () => {
	test("exports the component and props type", () => {
		expect(ContextRail).toBeDefined();
		expect(typeof ContextRail).toBe("function");
	});

	test("top-level Box has fixed width 28 and theme border", () => {
		const rendered = render(baseProps);
		const props = rendered.props as {
			width: number;
			flexShrink: number;
			borderStyle: string;
			borderColor: string;
			paddingX: number;
			flexDirection: string;
			overflow: string;
		};
		expect(props.width).toBe(28);
		expect(props.flexShrink).toBe(0);
		expect(props.borderStyle).toBe("single");
		expect(props.borderColor).toBe(t.border);
		expect(props.paddingX).toBe(1);
		expect(props.flexDirection).toBe("column");
		expect(props.overflow).toBe("hidden");
	});

	test("workspace name defaults to 8gent-code when omitted", () => {
		const rendered = render(baseProps);
		const children = React.Children.toArray(
			(rendered.props as { children: React.ReactNode }).children,
		) as React.ReactElement[];
		// children[1] is the workspace-name Text node (after the WORKSPACE header).
		const workspaceNode = children[1] as React.ReactElement<{ children: string }>;
		expect(workspaceNode.props.children).toBe("8gent-code");
	});

	test("workspace name override is honored", () => {
		const rendered = render({ ...baseProps, workspaceName: "8gi-governance" });
		const children = React.Children.toArray(
			(rendered.props as { children: React.ReactNode }).children,
		) as React.ReactElement[];
		const workspaceNode = children[1] as React.ReactElement<{ children: string }>;
		expect(workspaceNode.props.children).toBe("8gi-governance");
	});

	for (const risk of RISKS) {
		test(`risk "${risk}" maps to the correct theme color`, () => {
			const rendered = render({ ...baseProps, risk });
			const children = React.Children.toArray(
				(rendered.props as { children: React.ReactNode }).children,
			) as React.ReactElement[];
			// Layout (per component): [0] WORKSPACE header, [1] workspace name,
			// [2] branch Row, [3] spacer, [4] STATE header,
			// [5] approval Row, [6] risk Row, ...
			const riskRow = children[6] as React.ReactElement<{
				valueColor: string;
				value: string;
			}>;
			expect(riskRow.props.valueColor).toBe(expectedRiskColor[risk]);
			expect(riskRow.props.value).toBe(risk.toUpperCase());
		});
	}

	test("ADHD off renders muted label", () => {
		const rendered = render({ ...baseProps, adhdMode: false });
		const children = React.Children.toArray(
			(rendered.props as { children: React.ReactNode }).children,
		) as React.ReactElement[];
		const adhdRow = children[children.length - 1] as React.ReactElement<{
			valueColor: string;
		}>;
		expect(adhdRow.props.valueColor).toBe(t.muted);
	});

	test("ADHD on renders teal label", () => {
		const rendered = render({ ...baseProps, adhdMode: true });
		const children = React.Children.toArray(
			(rendered.props as { children: React.ReactNode }).children,
		) as React.ReactElement[];
		const adhdRow = children[children.length - 1] as React.ReactElement<{
			valueColor: string;
		}>;
		expect(adhdRow.props.valueColor).toBe(t.teal);
	});

	test("snapshot across all risk levels x ADHD modes is stable", () => {
		const matrix = RISKS.flatMap((risk) =>
			[false, true].map((adhdMode) => {
				const rendered = render({ ...baseProps, risk, adhdMode });
				const top = rendered.props as {
					width: number;
					borderStyle: string;
					borderColor: string;
					paddingX: number;
					flexShrink: number;
				};
				return {
					risk,
					adhdMode,
					width: top.width,
					borderStyle: top.borderStyle,
					borderColor: top.borderColor,
					paddingX: top.paddingX,
					flexShrink: top.flexShrink,
				};
			}),
		);
		expect(matrix).toMatchSnapshot();
	});
});
