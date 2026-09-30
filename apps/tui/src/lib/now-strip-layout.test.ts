import { describe, expect, test } from "bun:test";
import { cellWidth } from "./header-layout.js";
import { AUTONOMOUS_LABEL_WIDTH, NOW_LABEL_WIDTH, fitNowStrip } from "./now-strip-layout.js";

const done = { middle: "finished 2:06 AM", middleMin: 16, middleShort: "finished" };
const model = "qwen3.8:27b-mlx";

/** Columns the fitted strip draws, chrome and label included. */
function drawn(width: number, fit: ReturnType<typeof fitNowStrip>): number {
	return 4 + NOW_LABEL_WIDTH + 2 + cellWidth(fit.middle) + fit.rightWidth;
}

describe("fitNowStrip (audit #9: 'finis…')", () => {
	test("wide: everything whole", () => {
		const fit = fitNowStrip({ width: 92, ...done, route: model, tokens: "41K tok" });
		expect(fit).toMatchObject({ middle: "finished 2:06 AM", route: model, meter: true });
	});

	test("80-col chat (76 wide): with no mode word beside the state, everything fits whole (#3123)", () => {
		const fit = fitNowStrip({ width: 76, ...done, route: model, tokens: "5.7K tok" });
		expect(fit).toMatchObject({ middle: "finished 2:06 AM", route: model, meter: true });
		expect(drawn(76, fit)).toBeLessThanOrEqual(76);
	});

	test("narrower (64 wide): the model name gives way, the state word does not", () => {
		const fit = fitNowStrip({ width: 64, ...done, route: model, tokens: "5.7K tok" });
		expect(fit.middle).toBe("finished 2:06 AM");
		expect(fit.route).not.toBe(model);
		expect(fit.route === "" || fit.route.includes("…")).toBe(true);
		expect(drawn(64, fit)).toBeLessThanOrEqual(64);
	});

	test("autonomous widens the state column and the budget follows it", () => {
		const fit = fitNowStrip({ width: 76, labelWidth: AUTONOMOUS_LABEL_WIDTH, ...done, route: model, tokens: "5.7K tok" });
		expect(fit.middle).toBe("finished 2:06 AM");
		expect(4 + AUTONOMOUS_LABEL_WIDTH + 2 + cellWidth(fit.middle) + fit.rightWidth).toBeLessThanOrEqual(76);
	});

	test("then the meter goes, then the clock; the word 'finished' and the tokens stay", () => {
		for (let width = 30; width <= 120; width++) {
			const fit = fitNowStrip({ width, ...done, route: model, tokens: "5.7K tok" });
			expect(fit.middle.startsWith("finished")).toBe(true);
			expect(fit.middle).not.toContain("…");
			if (width >= 60) expect(drawn(width, fit)).toBeLessThanOrEqual(width);
		}
		const tight = fitNowStrip({ width: 36, ...done, route: model, tokens: "5.7K tok" });
		expect(tight).toMatchObject({ middle: "finished", route: "", meter: false });
	});

	test("an unknown route ('-') is not drawn", () => {
		expect(fitNowStrip({ width: 120, middle: "idle", middleMin: 4, route: "-", tokens: "0 tok" }).route).toBe("");
	});

	test("a long active step may be cut, but keeps its protected head", () => {
		const step = "Running bun test src/paginate.test.ts --coverage";
		const fit = fitNowStrip({ width: 76, middle: step, middleMin: 12, route: model, tokens: "5.7K tok" });
		expect(fit.middle).toBe(step);
		expect(4 + NOW_LABEL_WIDTH + 2 + 12 + fit.rightWidth).toBeLessThanOrEqual(76);
	});
});
