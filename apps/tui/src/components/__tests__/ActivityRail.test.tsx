/**
 * ActivityRail tests - structural snapshot for the right-column inspector.
 *
 * Pattern matches ContextRail.test.tsx and LilEightBadge.test.tsx: bun:test,
 * direct React-element-tree inspection, pure function of props.
 */

import { describe, expect, test } from "bun:test";
import { Text } from "ink";
import React from "react";
import {
	ActivityRail,
	providerDisplay,
	type ActivityRailProps,
	type ToolState,
	type ProviderState,
	type AgentState,
	type BodyPartState,
} from "../ActivityRail";
import { t } from "../../theme.js";
import { getProviderManager } from "../../../../../packages/providers/index.js";
import {
	bodyPartForToolName,
	detectDefaultBodyPartsState,
} from "../../hooks/useBodyParts.js";

const TOOL_STATES: ToolState[] = ["idle", "running", "ok", "fail"];
const PROVIDER_STATES: ProviderState[] = ["primary", "fallback", "offline"];
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
		{ name: "8gent:eight-1.0-q3:14b", state: "primary", latency: "12ms" },
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

type AnyElement = React.ReactElement<Record<string, unknown>>;

/**
 * Expand our own function components (RailSection, NamedRow, MetricRow,
 * TruncatedValue) so the tree is Ink Box/Text only. Ink's Text is itself a
 * function component that reads context, so it is left as a leaf.
 */
function expand(node: React.ReactNode): React.ReactNode {
	if (!React.isValidElement(node)) return node;
	const el = node as AnyElement;
	if (typeof el.type === "function" && el.type !== Text) {
		const rendered = (el.type as (p: Record<string, unknown>) => React.ReactNode)(el.props);
		return expand(rendered);
	}
	const kids = React.Children.map(el.props.children as React.ReactNode, expand);
	return React.cloneElement(el, undefined, ...(kids ?? []));
}

/** Depth-first list of every element in an expanded tree. */
function flatten(node: React.ReactNode, out: AnyElement[] = []): AnyElement[] {
	if (!React.isValidElement(node)) return out;
	const el = node as AnyElement;
	out.push(el);
	React.Children.forEach(el.props.children as React.ReactNode, (child) => flatten(child, out));
	return out;
}

/** Direct Box children of the rail column, function components expanded. */
function railColumn(props: ActivityRailProps): AnyElement[] {
	const top = expand(render(props)) as AnyElement;
	return React.Children.toArray(top.props.children as React.ReactNode).filter(
		React.isValidElement,
	) as AnyElement[];
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

	test("every block in the rail column refuses to shrink (#2921 idleS)", () => {
		for (const props of [baseProps, { ...baseProps, tasks: [] }]) {
			const blocks = railColumn({
				...props,
				bodyParts: { hands: "idle", eyes: "idle", handeyes: "disabled" },
			});
			expect(blocks.length).toBeGreaterThanOrEqual(7);
			for (const block of blocks) {
				expect(block.props.flexShrink).toBe(0);
			}
		}
	});

	test("rows never carry their own overflow clip (Ink honours only the innermost clip)", () => {
		const top = expand(render({
			...baseProps,
			bodyParts: { hands: "idle", eyes: "inFlight", handeyes: "disabled" },
		})) as AnyElement;
		const [root, ...rest] = flatten(top);
		expect(root.props.overflow).toBe("hidden");
		for (const el of rest) {
			expect(el.props.overflow).toBeUndefined();
			expect(el.props.overflowY).toBeUndefined();
		}
	});

	test("section headings and data rows are separate blocks", () => {
		const blocks = railColumn({ ...baseProps, tasks: [] });
		const tasks = blocks[1] as AnyElement;
		expect(tasks.props.flexDirection).toBe("column");
		const [heading, rows] = React.Children.toArray(tasks.props.children as React.ReactNode) as AnyElement[];
		expect(heading.props.flexShrink).toBe(0);
		expect(rows.props.flexShrink).toBe(0);
		expect(rows.props.flexDirection).toBe("column");
	});

	test("MEMORY renders only rows a source reports, and not at all without one (#3070)", () => {
		const titles = (props: ActivityRailProps) =>
			flatten(expand(render(props)))
				.filter((el) => el.type === Text)
				.map((el) => React.Children.toArray(el.props.children as React.ReactNode).join(""));
		const without = titles({ ...baseProps, memory: undefined });
		expect(without).not.toContain("MEMORY");
		expect(without).not.toContain("hits");
		const empty = titles({ ...baseProps, memory: {} });
		expect(empty).not.toContain("MEMORY");
		const partial = titles({ ...baseProps, memory: { hits: 4 } });
		expect(partial).toContain("MEMORY");
		expect(partial).toContain("hits");
		expect(partial).not.toContain("misses");
		expect(partial).not.toContain("cache");
	});

	test("a task's tone sets its colour: waiting is orange, a plan at rest is quiet (#3152)", () => {
		const colourOf = (label: string, tone?: "waiting" | "quiet") =>
			flatten(expand(render({ ...baseProps, tasks: [{ id: "x", label, tone }] })))
				.filter((el) => el.type === Text)
				.find((el) => React.Children.toArray(el.props.children as React.ReactNode).join("") === label)?.props
				.color;
		expect(colourOf("waiting for your answer", "waiting")).toBe(t.orange);
		expect(colourOf("3 steps planned", "quiet")).toBe(t.textSecondary);
		expect(colourOf("working, no plan yet")).toBe(t.teal);
	});

	test("a provider with no measured latency draws no trailing glyph (#3070)", () => {
		const texts = flatten(
			expand(render({ ...baseProps, providers: [{ name: "lmstudio:ornith", state: "primary" }] })),
		)
			.filter((el) => el.type === Text)
			.map((el) => React.Children.toArray(el.props.children as React.ReactNode).join(""));
		expect(texts).not.toContain("\u2014");
		expect(texts).not.toContain("-");
	});

	test("a fallback route says so in words, not by colour alone (#3070)", () => {
		const texts = flatten(
			expand(
				render({
					...baseProps,
					providers: [
						{ name: "lmstudio:ornith-1.0-9b", state: "primary" },
						{ name: "apfel:MiniMax-M2.7", state: "fallback" },
					],
				}),
			),
		)
			.filter((el) => el.type === Text)
			.map((el) => React.Children.toArray(el.props.children as React.ReactNode).join(""));
		expect(texts).toContain("● lmstudio ornith-1.0-9b");
		expect(texts).toContain("○ apfel MiniMax-M2.7");
		expect(texts).toContain("fallback");
	});

	test("the primary row names its real provider, never a tier word", () => {
		const texts = (name: string) =>
			flatten(expand(render({ ...baseProps, providers: [{ name, state: "primary" }] })))
				.filter((el) => el.type === Text)
				.map((el) => React.Children.toArray(el.props.children as React.ReactNode).join(""));
		expect(texts("8gent:eight-1.0-q3:14b")).toContain("● 8gent eight-1.0-q3:14b");
		expect(texts("ollama:qwen3.8:27b-mlx")).toContain("● ollama qwen3.8:27b-mlx");
		expect(texts("openrouter:auto:free")).toContain("● openrouter auto:free");
		for (const word of ["local:", "fallback:free", "route:available", "remote:standby"]) {
			expect(texts("8gent:eight-1.0-q3:14b").join(" ")).not.toContain(word);
		}
	});

	test("every provider in the registry is named by its own id, 8gent included", () => {
		// The registry is the list: a provider added to it is covered here with
		// no edit to the rail. Its ids carry no colon, which is what makes the
		// first colon of `provider:model` the exact split.
		const ids = getProviderManager()
			.listProviders()
			.map((p) => String(p.name));
		expect(ids).toContain("8gent");
		for (const id of ids) {
			expect(id).not.toContain(":");
			expect(providerDisplay(id)).toBe(id);
			expect(providerDisplay(`${id}:some-model:tag`)).toBe(`${id} some-model:tag`);
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
		const blocks = railColumn(baseProps).map((block) => ({
			flexShrink: block.props.flexShrink,
			flexDirection: block.props.flexDirection,
			marginTop: block.props.marginTop,
		}));
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
			blocks,
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
