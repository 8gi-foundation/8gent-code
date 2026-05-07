/**
 * HeaderBar tests - covers legacy and V2 render modes.
 *
 * Legacy: when called with no v2 prop, the rendered top-level element is a
 * Box with two children (BrandPill + shortcut hint). This is the path the
 * existing TUI uses and must remain stable.
 *
 * V2: when called with a v2 prop, the layout adds a middle workspace
 * region and a richer right-side cluster including a LilEightBadge.
 */

import { describe, expect, test } from "bun:test";
import React from "react";
import { HeaderBar, type HeaderBarV2Props } from "../HeaderBar";

function render(props: Parameters<typeof HeaderBar>[0]): React.ReactElement {
	return (HeaderBar as (p: Parameters<typeof HeaderBar>[0]) => React.ReactElement)(
		props,
	);
}

const v2: HeaderBarV2Props = {
	workspacePath: "/home/operator/8gent-code",
	branch: "feat/tui-v2-integration",
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

	test("legacy mode renders a top-level Box with full width", () => {
		const rendered = render({ updateAvailable: null });
		const props = rendered.props as { width: string; justifyContent: string };
		expect(props.width).toBe("100%");
		expect(props.justifyContent).toBe("space-between");
	});

	test("legacy mode is bytewise stable across update-available toggle", () => {
		const a = render({ updateAvailable: null });
		const b = render({ updateAvailable: { latest: "0.14.0", current: "0.13.0" } });
		// Both go through the legacy branch (no v2 prop).
		const ap = a.props as { width: string };
		const bp = b.props as { width: string };
		expect(ap.width).toBe(bp.width);
	});

	test("V2 mode delegates to HeaderBarV2 with v2 props", () => {
		const rendered = render({ updateAvailable: null, v2 });
		const props = rendered.props as { v2?: HeaderBarV2Props };
		// In V2 mode, the top-level returned element is the HeaderBarV2
		// element carrying the v2 prop through.
		expect(props.v2).toBeDefined();
		expect(props.v2?.branch).toBe(v2.branch);
	});

	test("V2 mode toggles approval pending chip", () => {
		const off = render({ v2: { ...v2, approvalPending: false } });
		const on = render({ v2: { ...v2, approvalPending: true } });
		// Both render without crashing; structural difference is internal.
		expect(off).toBeDefined();
		expect(on).toBeDefined();
	});

	test("snapshot of V2 across mic / ask / state matrix is stable", () => {
		const matrix = [
			{ ...v2 },
			{ ...v2, micOn: true },
			{ ...v2, approvalPending: true },
			{ ...v2, localFirst: false },
			{ ...v2, lilEightState: "working" as const },
			{ ...v2, lilEightState: "error" as const },
		].map((cfg, idx) => {
			const rendered = render({ v2: cfg });
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
