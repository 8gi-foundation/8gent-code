/**
 * HeaderBar tests - V2 chrome is the only render mode.
 *
 * The planHeader cases pin #2921: at 100 columns the workspace segment
 * wrapped above the brand pill, and at 120 the branch lost to the path.
 */

import { describe, expect, test } from "bun:test";
import React from "react";
import {
	HeaderBar,
	brandPillWidth,
	planHeader,
	statusClusterWidth,
	type HeaderBarProps,
} from "../HeaderBar";
import { headerMiddleWidth } from "../../lib/header-layout.js";

function render(props: HeaderBarProps): React.ReactElement {
	return (HeaderBar as (p: HeaderBarProps) => React.ReactElement)(props);
}

const base: HeaderBarProps = {
	updateAvailable: null,
	workspacePath: "/home/operator/8gent-code",
	branch: "feat/tui-v2-default",
	syncStatus: "in sync",
	micOn: false,
	approvalPending: false,
	localFirst: true,
	sessionTime: "1m 02",
	lilEightState: "idle",
};

// The live shape from the issue frame: a worktree path, a long branch,
// the version in the pill, a two-figure session clock.
const live: HeaderBarProps = {
	...base,
	version: "0.17.3",
	workspacePath: "/Users/operator/8gent-code/.claude/worktrees/agent-a8b0f5de5b64292c6",
	branch: "fix/header-rail-100-cols",
	syncStatus: "up to date",
	sessionTime: "2m 21s",
};

/** Columns the three header zones need side by side for a given plan. */
function occupied(props: HeaderBarProps): number {
	const plan = planHeader(props);
	return (
		brandPillWidth(props.version, props.updateAvailable, plan.compactBrand) +
		// The middle's paddingX={1} is only rendered when the middle is.
		(plan.middle.branch ? headerMiddleWidth(plan.middle) + 2 : 0) +
		statusClusterWidth(props, plan.compactHint)
	);
}

describe("HeaderBar", () => {
	test("exports the component", () => {
		expect(HeaderBar).toBeDefined();
		expect(typeof HeaderBar).toBe("function");
	});

	test("renders a top-level Box with full width", () => {
		const rendered = render(base);
		const props = rendered.props as { width: string; justifyContent: string };
		expect(props.width).toBe("100%");
		expect(props.justifyContent).toBe("space-between");
	});

	test("pill and status cluster never shrink and carry no fixed width", () => {
		type BoxProps = { flexShrink?: number; width?: number | string; children?: React.ReactNode };
		const rendered = render(live) as React.ReactElement<BoxProps>;
		const children = React.Children.toArray(rendered.props.children) as React.ReactElement<BoxProps>[];
		const [pill, , cluster] = children;
		expect(pill.props.flexShrink).toBe(0);
		expect(pill.props.width).toBeUndefined();
		expect(cluster.props.flexShrink).toBe(0);
		expect(cluster.props.width).toBeUndefined();
	});

	test("brand pill width matches the rendered pill", () => {
		// "│ 8gent Code v0.17.3 │ The Infinite Gentleman │" is 47 cells: no
		// stray full stop between the product name and the version.
		expect(brandPillWidth("0.17.3", null)).toBe(47);
		// Compact: "│ 8gent Code v0.17.3 │".
		expect(brandPillWidth("0.17.3", null, true)).toBe(22);
	});

	test("the pill reads 8gent Code v0.17.3, with no stray full stop", () => {
		type El = React.ReactElement<{ children?: React.ReactNode }>;
		const texts: string[] = [];
		const walk = (node: React.ReactNode) => {
			if (typeof node === "string") texts.push(node);
			if (!React.isValidElement(node)) return;
			const el = node as El;
			if (typeof el.type === "function" && (el.type as { name?: string }).name === "BrandPill") {
				walk((el.type as (p: unknown) => React.ReactNode)(el.props));
				return;
			}
			React.Children.forEach(el.props.children, walk);
		};
		walk(render({ ...live, width: 160 }));
		const pill = texts.join("");
		expect(pill).toContain(" Code v0.17.3");
		expect(pill).not.toContain("Code.");
	});

	test("toggles approval pending chip without crashing", () => {
		const off = render({ ...base, approvalPending: false });
		const on = render({ ...base, approvalPending: true });
		expect(off).toBeDefined();
		expect(on).toBeDefined();
	});

	test("at 100 columns nothing wraps and the branch survives", () => {
		const props = { ...live, width: 100 };
		const plan = planHeader(props);
		expect(plan.compactHint).toBe(true);
		expect(plan.middle.path).toBe("");
		expect(plan.middle.branch.startsWith("fix/header")).toBe(true);
		expect(occupied(props)).toBeLessThanOrEqual(100);
	});

	test("at 120 columns the whole branch beats the tail of the path", () => {
		const props = { ...live, width: 120 };
		const plan = planHeader(props);
		expect(plan.compactHint).toBe(false);
		expect(plan.middle.branch).toBe("fix/header-rail-100-cols");
		expect(occupied(props)).toBeLessThanOrEqual(120);
	});

	test("at 120 columns a short branch leaves room for a path slice", () => {
		const props = { ...live, branch: "main", width: 120 };
		const plan = planHeader(props);
		expect(plan.compactHint).toBe(false);
		expect(plan.middle.branch).toBe("main");
		expect(plan.middle.path.length).toBeGreaterThanOrEqual(12);
		expect(occupied(props)).toBeLessThanOrEqual(120);
	});

	test("at 140 columns a short branch shows path, branch and sync together", () => {
		const props = { ...live, branch: "main", width: 140 };
		const plan = planHeader(props);
		expect(plan.middle.branch).toBe("main");
		expect(plan.middle.sync).toBe("up to date");
		expect(plan.middle.path.length).toBeGreaterThanOrEqual(12);
		expect(occupied(props)).toBeLessThanOrEqual(140);
	});

	test("at 90 columns the row still fits in one line", () => {
		const props = { ...live, width: 90 };
		expect(occupied(props)).toBeLessThanOrEqual(90);
	});

	test("the status badge is never clipped, 70 to 200 columns, every state (audit #2)", () => {
		const states = ["idle", "thinking", "working", "done", "error", "sleep"] as const;
		for (const lilEightState of states) {
			for (const busy of [false, true]) {
				const props0 = { ...live, lilEightState, micOn: busy, approvalPending: busy };
				// 70 is the floor: the compact pill plus the busiest cluster
				// ("[ASK]", mic on, "thinking") is 66 columns.
				for (let width = 70; width <= 200; width++) {
					expect(occupied({ ...props0, width })).toBeLessThanOrEqual(width);
				}
			}
		}
	});

	test("at 80 columns the tagline gives way before the badge, and the branch stays", () => {
		// The pilot frame: `│ 8▣ idle` lost its right border off-screen at 80.
		const props = { ...live, branch: "main", width: 80 };
		const plan = planHeader(props);
		expect(plan.compactBrand).toBe(true);
		expect(plan.middle.branch).toBe("main");
		expect(occupied(props)).toBeLessThanOrEqual(80);
	});

	test("at 80 columns outside a repo the header says 'no repo' (#3070)", () => {
		const props = { ...live, branch: "", syncStatus: "no repo", sessionTime: "7s", width: 80 };
		const plan = planHeader(props);
		expect(plan.middle.sync).toBe("no repo");
		expect(
			brandPillWidth(props.version, props.updateAvailable, plan.compactBrand) +
				headerMiddleWidth(plan.middle) +
				2 +
				statusClusterWidth(props, plan.compactHint),
		).toBeLessThanOrEqual(80);
	});

	test("the middle reads from the left: 'no repo' sits where a branch would, not centred", () => {
		const middleBox = (props: HeaderBarProps) => {
			const kids = React.Children.toArray(
				(render(props).props as { children: React.ReactNode }).children,
			) as React.ReactElement<Record<string, unknown>>[];
			return kids[1];
		};
		const noRepo = middleBox({ ...live, branch: "", syncStatus: "no repo", sessionTime: "7s", width: 80 });
		const branchOnly = middleBox({ ...live, branch: "main", width: 80 });
		const wide = middleBox({ ...live, width: 160 });
		for (const box of [noRepo, branchOnly, wide]) {
			expect(box.props.flexGrow).toBe(1);
			expect(box.props.justifyContent).toBe("flex-start");
		}
	});

	test("defaults to an 80 column plan when width is omitted", () => {
		expect(planHeader(live)).toEqual(planHeader({ ...live, width: 80 }));
		expect(occupied(live)).toBeLessThanOrEqual(80);
	});

	test("snapshot across mic / ask / state matrix is stable", () => {
		const matrix = [
			{ ...base },
			{ ...base, micOn: true },
			{ ...base, approvalPending: true },
			{ ...base, localFirst: false },
			{ ...base, lilEightState: "working" as const },
			{ ...base, lilEightState: "error" as const },
		].map((cfg, idx) => {
			const rendered = render(cfg);
			const top = rendered.props as { width: string; justifyContent: string };
			return {
				idx,
				width: top.width,
				justifyContent: top.justifyContent,
				micOn: cfg.micOn,
				approvalPending: cfg.approvalPending,
				localFirst: cfg.localFirst,
				lilEightState: cfg.lilEightState,
			};
		});
		expect(matrix).toMatchSnapshot();
	});
});
