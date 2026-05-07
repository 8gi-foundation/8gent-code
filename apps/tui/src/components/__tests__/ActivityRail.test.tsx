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
} from "../ActivityRail";
import { t } from "../../theme.js";

const TOOL_STATES: ToolState[] = ["idle", "running", "ok", "fail"];
const PROVIDER_STATES: ProviderState[] = ["local", "fallback", "offline"];
const AGENT_STATES: AgentState[] = ["idle", "active", "blocked"];

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

	test("top-level Box is 32 cols wide with single border", () => {
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
		expect(props.width).toBe(32);
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
