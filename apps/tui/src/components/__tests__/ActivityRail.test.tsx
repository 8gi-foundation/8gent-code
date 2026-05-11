/**
 * ActivityRail tests - structural snapshot for the right-column inspector.
 *
 * Pattern matches ContextRail.test.tsx and LilEightBadge.test.tsx: bun:test,
 * direct React-element-tree inspection, pure function of props.
 */

import { describe, expect, test } from "bun:test";
import React from "react";
import {
	ActivityRail,
	type ActivityRailProps,
	type ToolState,
	type ProviderState,
	type AgentState,
	type BodyPartState,
} from "../ActivityRail";
import { t } from "../../theme.js";
import {
	bodyPartForToolName,
	detectDefaultBodyPartsState,
} from "../../hooks/useBodyParts.js";

const TOOL_STATES: ToolState[] = ["idle", "running", "ok", "fail"];
const PROVIDER_STATES: ProviderState[] = ["local", "fallback", "offline"];
const AGENT_STATES: AgentState[] = ["idle", "active", "blocked"];
const BODY_PART_STATES: BodyPartState[] = ["disabled", "idle", "inFlight"];

const baseProps: ActivityRailProps = {
	tasks: [
		{ id: "t1", label: "patch HeaderBar", progress: 35 },
		{ id: "t2", label: "run typecheck", progress: 80 },
	],
	tools: [
		{ name: "read", state: "ok" },
		{ name: "patch", state: "running" },
		{ name: "test", state: "idle" },
		{ name: "verify", state: "fail" },
	],
	providers: [
		{ name: "8gent local", state: "local", latency: "12ms" },
		{ name: "ollama", state: "fallback", latency: "180ms" },
	],
	memory: { hits: 42, misses: 3, cache: "1.2MB" },
	agents: [
		{ name: "Core", state: "active" },
		{ name: "Research", state: "idle" },
		{ name: "Tester", state: "blocked" },
		{ name: "Reviewer", state: "idle" },
	],
};

function render(props: ActivityRailProps): React.ReactElement {
	return (ActivityRail as (p: ActivityRailProps) => React.ReactElement)(props);
}

describe("ActivityRail", () => {
	test("exports the component and types", () => {
		expect(ActivityRail).toBeDefined();
		expect(typeof ActivityRail).toBe("function");
	});

	test("top-level Box is 34 cols wide with single border", () => {
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
		expect(props.width).toBe(34);
		expect(props.flexShrink).toBe(0);
		expect(props.borderStyle).toBe("single");
		expect(props.borderColor).toBe(t.border);
		expect(props.paddingX).toBe(1);
		expect(props.flexDirection).toBe("column");
		expect(props.overflow).toBe("hidden");
	});

	test("renders without crashing for empty tasks", () => {
		const rendered = render({ ...baseProps, tasks: [] });
		expect(rendered).toBeDefined();
	});

	test("each tool state renders without crashing", () => {
		for (const state of TOOL_STATES) {
			const rendered = render({
				...baseProps,
				tools: [{ name: state, state }],
			});
			expect(rendered).toBeDefined();
		}
	});

	test("each provider state renders without crashing", () => {
		for (const state of PROVIDER_STATES) {
			const rendered = render({
				...baseProps,
				providers: [{ name: state, state, latency: "1ms" }],
			});
			expect(rendered).toBeDefined();
		}
	});

	test("each agent state renders without crashing", () => {
		for (const state of AGENT_STATES) {
			const rendered = render({
				...baseProps,
				agents: [{ name: state, state }],
			});
			expect(rendered).toBeDefined();
		}
	});

	test("renders without crashing when bodyParts prop is omitted", () => {
		const rendered = render(baseProps);
		expect(rendered).toBeDefined();
	});

	test("each body-part state renders without crashing", () => {
		for (const state of BODY_PART_STATES) {
			const rendered = render({
				...baseProps,
				bodyParts: { hands: state, eyes: state, handeyes: state },
			});
			expect(rendered).toBeDefined();
		}
	});

	test("body-parts mixed-state render is stable", () => {
		const rendered = render({
			...baseProps,
			bodyParts: { hands: "idle", eyes: "inFlight", handeyes: "disabled" },
		});
		expect(rendered).toBeDefined();
	});

	test("snapshot of full rail is stable", () => {
		const rendered = render(baseProps);
		const top = rendered.props as {
			width: number;
			flexShrink: number;
			borderStyle: string;
			borderColor: string;
			paddingX: number;
			flexDirection: string;
			overflow: string;
		};
		expect({
			width: top.width,
			flexShrink: top.flexShrink,
			borderStyle: top.borderStyle,
			borderColor: top.borderColor,
			paddingX: top.paddingX,
			flexDirection: top.flexDirection,
			overflow: top.overflow,
			tasks: baseProps.tasks.length,
			tools: baseProps.tools.length,
			providers: baseProps.providers.length,
			agents: baseProps.agents.length,
		}).toMatchSnapshot();
	});
});

describe("useBodyParts helpers", () => {
	test("bodyPartForToolName maps desktop_ prefix to hands", () => {
		expect(bodyPartForToolName("desktop_click")).toBe("hands");
		expect(bodyPartForToolName("desktop_type_text")).toBe("hands");
	});

	test("bodyPartForToolName maps eyes_ prefix to eyes", () => {
		expect(bodyPartForToolName("eyes_read")).toBe("eyes");
		expect(bodyPartForToolName("eyes_screenshot")).toBe("eyes");
	});

	test("bodyPartForToolName maps handeyes_ prefix to handeyes", () => {
		expect(bodyPartForToolName("handeyes_loop")).toBe("handeyes");
		expect(bodyPartForToolName("handeyes_engage")).toBe("handeyes");
	});

	test("bodyPartForToolName returns null for unrelated tools", () => {
		expect(bodyPartForToolName("read")).toBeNull();
		expect(bodyPartForToolName("bash")).toBeNull();
		expect(bodyPartForToolName(null)).toBeNull();
		expect(bodyPartForToolName(undefined)).toBeNull();
		expect(bodyPartForToolName("")).toBeNull();
	});

	test("detectDefaultBodyPartsState returns valid states for all parts", () => {
		const state = detectDefaultBodyPartsState();
		const allowed: BodyPartState[] = ["disabled", "idle", "inFlight"];
		expect(allowed).toContain(state.hands);
		expect(allowed).toContain(state.eyes);
		expect(allowed).toContain(state.handeyes);
		// handeyes is only enabled when both hands and eyes are.
		if (state.handeyes === "idle") {
			expect(state.hands).toBe("idle");
			expect(state.eyes).toBe("idle");
		}
	});
});
