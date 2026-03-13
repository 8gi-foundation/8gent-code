import { describe, it, expect, beforeEach } from "bun:test";
import * as path from "path";

const WORK_DIR = process.env.WORK_DIR || path.dirname(process.env.FIXTURE_PATH || ".");

let chart: any, scale: any, layout: any;

beforeEach(async () => {
  try {
    chart = await import(path.join(WORK_DIR, "chart.ts"));
    scale = await import(path.join(WORK_DIR, "scale.ts"));
    layout = await import(path.join(WORK_DIR, "layout.ts"));
  } catch {}
});

describe("Chart — generateSVG", () => {
  it("generates valid SVG with <svg> root for bar chart", () => {
    const generateSVG = chart.generateSVG || chart.default?.generateSVG;
    const svg = generateSVG({
      type: "bar",
      data: [{ label: "A", value: 10 }, { label: "B", value: 20 }, { label: "C", value: 15 }],
      options: { width: 400, height: 300 },
    });
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect(svg).toContain("<rect");
  });

  it("includes title element when title option provided", () => {
    const generateSVG = chart.generateSVG || chart.default?.generateSVG;
    const svg = generateSVG({
      type: "bar",
      data: [{ label: "A", value: 10 }],
      options: { title: "My Chart" },
    });
    expect(svg).toContain("<title>");
    expect(svg).toContain("My Chart");
  });

  it("generates pie chart with path elements", () => {
    const generateSVG = chart.generateSVG || chart.default?.generateSVG;
    const svg = generateSVG({
      type: "pie",
      data: [{ label: "A", value: 60 }, { label: "B", value: 40 }],
    });
    expect(svg).toContain("<svg");
    expect(svg).toContain("<path");
  });
});

describe("Chart — generateASCII", () => {
  it("generates ASCII bar chart with block characters", () => {
    const generateASCII = chart.generateASCII || chart.default?.generateASCII;
    const ascii = generateASCII({
      type: "bar",
      data: [{ label: "A", value: 10 }, { label: "B", value: 20 }],
    });
    expect(typeof ascii).toBe("string");
    expect(ascii.length).toBeGreaterThan(0);
    expect(ascii).toContain("A");
    expect(ascii).toContain("B");
  });
});

describe("Chart — calculateBounds", () => {
  it("calculates correct min, max, range", () => {
    const calculateBounds = chart.calculateBounds || chart.default?.calculateBounds;
    const result = calculateBounds([2, 4, 6, 8, 10]);
    expect(result.min).toBe(2);
    expect(result.max).toBe(10);
    expect(result.range).toBe(8);
  });

  it("calculates correct mean", () => {
    const calculateBounds = chart.calculateBounds || chart.default?.calculateBounds;
    const result = calculateBounds([2, 4, 6, 8, 10]);
    expect(result.mean).toBe(6);
  });

  it("calculates correct median for odd-length array", () => {
    const calculateBounds = chart.calculateBounds || chart.default?.calculateBounds;
    const result = calculateBounds([1, 3, 5, 7, 9]);
    expect(result.median).toBe(5);
  });

  it("calculates population stdDev", () => {
    const calculateBounds = chart.calculateBounds || chart.default?.calculateBounds;
    const result = calculateBounds([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(result.stdDev).toBeGreaterThan(0);
    expect(typeof result.stdDev).toBe("number");
  });
});

describe("Scale functions", () => {
  it("linearScale maps domain endpoints to range endpoints", () => {
    const linearScale = scale.linearScale || scale.default?.linearScale;
    const s = linearScale([0, 100], [0, 500]);
    expect(s(0)).toBe(0);
    expect(s(100)).toBe(500);
    expect(s(50)).toBe(250);
  });

  it("logScale maps using logarithmic scale", () => {
    const logScale = scale.logScale || scale.default?.logScale;
    const s = logScale([1, 1000], [0, 300]);
    expect(s(1)).toBe(0);
    expect(s(1000)).toBe(300);
    const mid = s(10);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(300);
  });

  it("bandScale distributes categories evenly", () => {
    const bandScale = scale.bandScale || scale.default?.bandScale;
    const s = bandScale(["A", "B", "C"], [0, 300]);
    const posA = s("A");
    const posB = s("B");
    const posC = s("C");
    expect(posA).toBeLessThan(posB);
    expect(posB).toBeLessThan(posC);
  });

  it("colorScale returns hex color strings", () => {
    const colorScale = scale.colorScale || scale.default?.colorScale;
    const s = colorScale([0, 100], ["#000000", "#ffffff"]);
    const color = s(50);
    expect(typeof color).toBe("string");
    expect(color.startsWith("#")).toBe(true);
  });

  it("niceNumbers returns clean tick values extending beyond min/max", () => {
    const niceNumbers = scale.niceNumbers || scale.default?.niceNumbers;
    const ticks = niceNumbers(0.5, 9.8, 5);
    expect(Array.isArray(ticks)).toBe(true);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks[0]).toBeLessThanOrEqual(0.5);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(9.8);
  });
});

describe("Layout functions", () => {
  it("calculateBarLayout returns positioned rectangles", () => {
    const calculateBarLayout = layout.calculateBarLayout || layout.default?.calculateBarLayout;
    const bars = calculateBarLayout(
      [{ label: "A", value: 10 }, { label: "B", value: 20 }, { label: "C", value: 15 }],
      400, 300, 10,
    );
    expect(bars.length).toBe(3);
    expect(bars[0]).toHaveProperty("x");
    expect(bars[0]).toHaveProperty("y");
    expect(bars[0]).toHaveProperty("width");
    expect(bars[0]).toHaveProperty("height");
    expect(bars[0]).toHaveProperty("label");
  });

  it("calculatePieLayout angles sum to 2π", () => {
    const calculatePieLayout = layout.calculatePieLayout || layout.default?.calculatePieLayout;
    const slices = calculatePieLayout([
      { label: "A", value: 30 },
      { label: "B", value: 50 },
      { label: "C", value: 20 },
    ]);
    expect(slices.length).toBe(3);
    const totalAngle = slices.reduce((sum: number, s: any) => sum + (s.endAngle - s.startAngle), 0);
    expect(Math.abs(totalAngle - 2 * Math.PI)).toBeLessThan(0.001);
  });

  it("calculatePieLayout percentages sum to 100", () => {
    const calculatePieLayout = layout.calculatePieLayout || layout.default?.calculatePieLayout;
    const slices = calculatePieLayout([
      { label: "A", value: 25 },
      { label: "B", value: 75 },
    ]);
    const totalPct = slices.reduce((sum: number, s: any) => sum + s.percentage, 0);
    expect(Math.abs(totalPct - 100)).toBeLessThan(0.01);
  });

  it("calculateGridLayout returns rows and cols", () => {
    const calculateGridLayout = layout.calculateGridLayout || layout.default?.calculateGridLayout;
    const grid = calculateGridLayout(12, 600, 400);
    expect(grid).toHaveProperty("cols");
    expect(grid).toHaveProperty("rows");
    expect(grid).toHaveProperty("cellWidth");
    expect(grid).toHaveProperty("cellHeight");
    expect(grid.cols * grid.rows).toBeGreaterThanOrEqual(12);
  });

  it("calculateAxisTicks returns normalized positions between 0 and 1", () => {
    const calculateAxisTicks = layout.calculateAxisTicks || layout.default?.calculateAxisTicks;
    const ticks = calculateAxisTicks(0, 100, 5);
    expect(Array.isArray(ticks)).toBe(true);
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) {
      expect(tick).toHaveProperty("value");
      expect(tick).toHaveProperty("position");
      expect(tick.position).toBeGreaterThanOrEqual(0);
      expect(tick.position).toBeLessThanOrEqual(1);
    }
  });
});
