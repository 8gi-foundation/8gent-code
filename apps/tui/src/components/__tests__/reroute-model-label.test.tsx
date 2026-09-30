/**
 * #3102: the places the TUI names a model say which model ran the turn after
 * a reroute, and mark the one asked for as asked.
 *
 *   NOW strip   qwen3.8:27b-mlx (asked eight-1.0-q3:14b) ctx ████░░ 51K tok
 *   PROVIDERS   ● ollama qwen3.8:27b-mlx   (the provider that served it, #3106 review)
 *                 (asked eight-1.0-q3:14b)
 *
 * The footer no longer names the model (#3238): the NOW strip is its home.
 * The note takes the existing muted tone; no colour or layout is new.
 */

import { describe, expect, test } from "bun:test";
import { Text } from "ink";
import React from "react";
import { deriveProviders } from "../../lib/activity-rail-derivation.js";
import { cellWidth } from "../../lib/header-layout.js";
import { NOW_LABEL_WIDTH, fitNowStrip } from "../../lib/now-strip-layout.js";
import { t } from "../../theme.js";
import { ActivityRail, type ActivityRailProps } from "../ActivityRail";
import { buildFooterSegments } from "../StatusFooter.js";

const ASKED = "eight-1.0-q3:14b";
const RAN = "qwen3.8:27b-mlx";
const done = { middle: "finished 5:40 AM", middleMin: 16, middleShort: "finished" };

describe("NOW strip", () => {
	test("wide: the model that ran, then the asked one as a note", () => {
		const fit = fitNowStrip({ width: 120, ...done, route: RAN, asked: ASKED, tokens: "51K tok" });
		expect(fit).toMatchObject({ route: RAN, asked: `(asked ${ASKED})`, meter: true });
	});

	test("the note gives way before the model that ran is cut", () => {
		// Room for the whole route but not the note.
		const fit = fitNowStrip({ width: 90, ...done, route: RAN, asked: ASKED, tokens: "51K tok" });
		expect(fit.asked).toBe("");
		expect(fit.route).toBe(RAN);
	});

	test("never wider than the strip, never a cut note", () => {
		for (let width = 40; width <= 160; width++) {
			const fit = fitNowStrip({ width, ...done, route: RAN, asked: ASKED, tokens: "51K tok" });
			expect(fit.asked === "" || fit.asked === `(asked ${ASKED})`).toBe(true);
			if (fit.asked) expect(fit.route).toBe(RAN);
			if (width >= 60) {
				expect(4 + NOW_LABEL_WIDTH + 2 + cellWidth(fit.middle) + fit.rightWidth).toBeLessThanOrEqual(width);
			}
		}
	});

	test("no reroute: unchanged, no note", () => {
		const fit = fitNowStrip({ width: 120, ...done, route: ASKED, tokens: "51K tok" });
		expect(fit).toMatchObject({ route: ASKED, asked: "" });
	});
});

describe("status bar", () => {
	test("the footer does not repeat the model (#3238): the NOW strip is its home", () => {
		const segs = buildFooterSegments({ mode: "Planning" });
		expect(segs.some((s) => s.key === "model")).toBe(false);
	});
});

type AnyElement = React.ReactElement<Record<string, unknown>>;
function expand(node: React.ReactNode): React.ReactNode {
	if (!React.isValidElement(node)) return node;
	const el = node as AnyElement;
	if (typeof el.type === "function" && el.type !== Text) {
		return expand((el.type as (p: Record<string, unknown>) => React.ReactNode)(el.props));
	}
	const kids = React.Children.map(el.props.children as React.ReactNode, expand);
	return React.cloneElement(el, undefined, ...(kids ?? []));
}
function texts(node: React.ReactNode, out: AnyElement[] = []): AnyElement[] {
	if (!React.isValidElement(node)) return out;
	const el = node as AnyElement;
	if (el.type === Text) out.push(el);
	React.Children.forEach(el.props.children as React.ReactNode, (c) => texts(c, out));
	return out;
}
const str = (el: AnyElement) => React.Children.toArray(el.props.children as React.ReactNode).join("");

function rail(providers: ActivityRailProps["providers"]): AnyElement[] {
	const props: ActivityRailProps = { tasks: [], tools: [], providers, agents: [] };
	return texts(expand((ActivityRail as (p: ActivityRailProps) => React.ReactElement)(props)));
}

describe("PROVIDERS row", () => {
	test("the primary row names the model that ran; the asked one follows, muted", () => {
		const rows = deriveProviders({ primary: { name: `8gent:${RAN}`, asked: ASKED }, fallback: null, offline: null });
		const els = rail(rows);
		const names = els.map(str);
		expect(names).toContain(`● 8gent ${RAN}`);
		expect(names).not.toContain(`● 8gent ${ASKED}`);
		const note = els.find((el) => str(el).includes(`(asked ${ASKED})`));
		expect(note).toBeDefined();
		expect(note?.props.color).toBe(t.textTertiary);
	});

	test("no reroute: one row, no note", () => {
		const names = rail(deriveProviders({ primary: { name: `8gent:${ASKED}` }, fallback: null, offline: null })).map(str);
		expect(names).toContain(`● 8gent ${ASKED}`);
		expect(names.join(" ")).not.toContain("asked");
	});
});
