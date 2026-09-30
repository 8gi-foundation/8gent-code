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

	function rows(props: ContextRailProps): React.ReactElement[] {
		const rendered = render(props);
		return React.Children.toArray(
			(rendered.props as { children: React.ReactNode }).children,
		) as React.ReactElement[];
	}
	function textOf(el: React.ReactElement): string {
		const c = (el.props as { children?: unknown }).children;
		return typeof c === "string" ? c : "";
	}
	function metric(props: ContextRailProps, label: string) {
		return rows(props).find((el) => (el.props as { label?: string }).label === label) as
			| React.ReactElement<{ color: string; value: string }>
			| undefined;
	}

	test("does not repeat the header (audit 2026-09-30, #5): no workspace, no branch, no 'no repo'", () => {
		const texts = rows(baseProps).map(textOf);
		expect(texts[0]).toBe("STATE");
		expect(texts).not.toContain("WORKSPACE");
		expect(texts).not.toContain("no repo");
		expect(metric(baseProps, "branch")).toBeUndefined();
	});

	test("section labels use the calm heading tone, not orange", () => {
		const headings = rows(baseProps).filter((el) =>
			["STATE", "CONTEXT", "ACCESS"].includes(textOf(el)),
		);
		expect(headings).toHaveLength(3);
		for (const h of headings) expect((h.props as { color: string }).color).toBe(t.heading);
	});

	for (const risk of RISKS) {
		test(`risk "${risk}" maps to the correct theme color`, () => {
			const riskRow = metric({ ...baseProps, risk }, "risk");
			expect(riskRow?.props.color).toBe(expectedRiskColor[risk]);
			expect(riskRow?.props.value).toBe(risk.toUpperCase());
		});
	}

	test("ADHD off renders textSecondary label", () => {
		const rendered = render({ ...baseProps, adhdMode: false });
		const children = React.Children.toArray(
			(rendered.props as { children: React.ReactNode }).children,
		) as React.ReactElement[];
		const adhdRow = children[children.length - 1] as React.ReactElement<{
			color: string;
		}>;
		expect(adhdRow.props.color).toBe(t.textSecondary);
	});

	test("ADHD on renders teal label", () => {
		const rendered = render({ ...baseProps, adhdMode: true });
		const children = React.Children.toArray(
			(rendered.props as { children: React.ReactNode }).children,
		) as React.ReactElement[];
		const adhdRow = children[children.length - 1] as React.ReactElement<{
			color: string;
		}>;
		expect(adhdRow.props.color).toBe(t.teal);
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
