/**
 * HeaderBar tests - V2 chrome is the only render mode.
 */

import { describe, expect, test } from "bun:test";
import React from "react";
import { HeaderBar, type HeaderBarProps } from "../HeaderBar";

function render(props: HeaderBarProps): React.ReactElement {
	return (HeaderBar as (p: HeaderBarProps) => React.ReactElement)(props);
}

const base: HeaderBarProps = {
	updateAvailable: null,
	workspacePath: "/Users/dev/8gent-code",
	branch: "feat/tui-v2-default",
	syncStatus: "in sync",
	micOn: false,
	approvalPending: false,
	localFirst: true,
	sessionTime: "1m 02",
	lilEightState: "idle",
};

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

	test("toggles approval pending chip without crashing", () => {
		const off = render({ ...base, approvalPending: false });
		const on = render({ ...base, approvalPending: true });
		expect(off).toBeDefined();
		expect(on).toBeDefined();
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
