import { describe, it, expect, beforeEach } from "bun:test";
import * as path from "path";

const WORK_DIR = process.env.WORK_DIR || path.dirname(process.env.FIXTURE_PATH || ".");

let models: any, calculator: any, formatter: any;

beforeEach(async () => {
  try {
    models = await import(path.join(WORK_DIR, "models.ts"));
    calculator = await import(path.join(WORK_DIR, "calculator.ts"));
    formatter = await import(path.join(WORK_DIR, "formatter.ts"));
  } catch {}
});

describe("Financial Calculator", () => {
  it("calculateROI returns positive ROI for profit", () => {
    const calcROI = calculator.calculateROI || calculator.default?.calculateROI;
    const result = calcROI(1500, 1000);
    expect(result).toBe(50);
  });

  it("calculateROI returns negative ROI for loss", () => {
    const calcROI = calculator.calculateROI || calculator.default?.calculateROI;
    const result = calcROI(800, 1000);
    expect(result).toBe(-20);
  });

  it("calculateNPV returns positive for profitable cash flows", () => {
    const calcNPV = calculator.calculateNPV || calculator.default?.calculateNPV;
    const result = calcNPV(0.1, [-1000, 300, 420, 680]);
    expect(result).toBeGreaterThan(0);
  });

  it("calculateNPV returns negative for all negative cash flows", () => {
    const calcNPV = calculator.calculateNPV || calculator.default?.calculateNPV;
    const result = calcNPV(0.1, [-1000, -200, -300]);
    expect(result).toBeLessThan(0);
  });

  it("calculateDebtToEquity returns correct ratio", () => {
    const calcDTE = calculator.calculateDebtToEquity || calculator.default?.calculateDebtToEquity;
    const result = calcDTE(500000, 1000000);
    expect(result).toBe(0.5);
  });

  it("calculateCurrentRatio returns correct ratio", () => {
    const calcCR = calculator.calculateCurrentRatio || calculator.default?.calculateCurrentRatio;
    const result = calcCR(150000, 100000);
    expect(result).toBe(1.5);
  });

  it("calculateGrossMargin returns correct percentage", () => {
    const calcGM = calculator.calculateGrossMargin || calculator.default?.calculateGrossMargin;
    const result = calcGM(100000, 60000);
    expect(result).toBe(40);
  });

  it("calculateNetMargin returns correct percentage", () => {
    const calcNM = calculator.calculateNetMargin || calculator.default?.calculateNetMargin;
    const result = calcNM(20000, 100000);
    expect(result).toBe(20);
  });

  it("calculateEBITDA returns correct value", () => {
    const calcEBITDA = calculator.calculateEBITDA || calculator.default?.calculateEBITDA;
    const result = calcEBITDA(50000, 10000, 15000, 5000, 3000);
    expect(result).toBe(83000);
  });

  it("analyzeFinancials returns object with all ratios", () => {
    const analyze = calculator.analyzeFinancials || calculator.default?.analyzeFinancials;
    const result = analyze({
      revenue: 100000,
      cogs: 60000,
      netIncome: 20000,
      totalDebt: 500000,
      equity: 1000000,
      currentAssets: 150000,
      currentLiabilities: 100000,
    });
    expect(result).toHaveProperty("grossMargin");
    expect(result).toHaveProperty("netMargin");
    expect(result).toHaveProperty("debtToEquity");
    expect(result).toHaveProperty("currentRatio");
  });
});

describe("Financial Formatter", () => {
  it("formatCurrency formats with commas and dollar sign", () => {
    const fmtCurrency = formatter.formatCurrency || formatter.default?.formatCurrency;
    const result = fmtCurrency(1234567.89);
    expect(result).toContain("1,234,567");
  });

  it("formatPercentage formats decimal as percentage", () => {
    const fmtPct = formatter.formatPercentage || formatter.default?.formatPercentage;
    const result = fmtPct(0.4567);
    expect(result).toContain("45.67%");
  });

  it("formatFinancialReport returns string with key sections", () => {
    const fmtReport = formatter.formatFinancialReport || formatter.default?.formatFinancialReport;
    const result = fmtReport({
      grossMargin: 40,
      netMargin: 20,
      debtToEquity: 0.5,
      currentRatio: 1.5,
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("formatCurrency handles zero", () => {
    const fmtCurrency = formatter.formatCurrency || formatter.default?.formatCurrency;
    const result = fmtCurrency(0);
    expect(result).toContain("0");
  });
});
