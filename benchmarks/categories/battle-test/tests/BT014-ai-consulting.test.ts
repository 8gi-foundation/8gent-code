import { describe, it, expect, beforeEach } from "bun:test";
import * as path from "path";

const WORK_DIR = process.env.WORK_DIR || path.dirname(process.env.FIXTURE_PATH || ".");

let assessment: any, recommendation: any, roadmap: any;

beforeEach(async () => {
  try {
    assessment = await import(path.join(WORK_DIR, "assessment.ts"));
    recommendation = await import(path.join(WORK_DIR, "recommendation.ts"));
    roadmap = await import(path.join(WORK_DIR, "roadmap.ts"));
  } catch {}
});

const sampleProfile = {
  name: "Acme Corp",
  size: "smb" as const,
  industry: "retail",
  currentTools: ["Excel", "Google Analytics", "Shopify"],
  dataMaturity: 3 as const,
  budget: 75000,
  painPoints: ["manual inventory", "slow reporting", "customer churn"],
};

const advancedProfile = {
  name: "TechGiant",
  size: "enterprise" as const,
  industry: "tech",
  currentTools: ["Snowflake", "dbt", "Airflow", "TensorFlow", "MLflow"],
  dataMaturity: 5 as const,
  budget: 500000,
  painPoints: ["scaling ML", "real-time inference"],
};

describe("Assessment", () => {
  it("assessAIReadiness returns a score between 0 and 100", () => {
    const assessAIReadiness = assessment.assessAIReadiness || assessment.default?.assessAIReadiness;
    const report = assessAIReadiness(sampleProfile);
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
  });

  it("assessAIReadiness returns correct tier for SMB profile", () => {
    const assessAIReadiness = assessment.assessAIReadiness || assessment.default?.assessAIReadiness;
    const report = assessAIReadiness(sampleProfile);
    expect(["beginner", "intermediate", "advanced"]).toContain(report.tier);
  });

  it("assessAIReadiness returns advanced tier for enterprise profile", () => {
    const assessAIReadiness = assessment.assessAIReadiness || assessment.default?.assessAIReadiness;
    const report = assessAIReadiness(advancedProfile);
    expect(report.tier).toBe("advanced");
  });

  it("report includes strengths, gaps, and risks arrays", () => {
    const assessAIReadiness = assessment.assessAIReadiness || assessment.default?.assessAIReadiness;
    const report = assessAIReadiness(sampleProfile);
    expect(Array.isArray(report.strengths)).toBe(true);
    expect(Array.isArray(report.gaps)).toBe(true);
    expect(Array.isArray(report.risks)).toBe(true);
  });

  it("assessAIReadiness is deterministic", () => {
    const assessAIReadiness = assessment.assessAIReadiness || assessment.default?.assessAIReadiness;
    const r1 = assessAIReadiness(sampleProfile);
    const r2 = assessAIReadiness(sampleProfile);
    expect(r1.score).toBe(r2.score);
    expect(r1.tier).toBe(r2.tier);
  });

  it("benchmarkAgainstIndustry returns percentile", () => {
    const benchmarkAgainstIndustry = assessment.benchmarkAgainstIndustry || assessment.default?.benchmarkAgainstIndustry;
    const industryData = [
      { ...sampleProfile, name: "Comp1", dataMaturity: 1 as const },
      { ...sampleProfile, name: "Comp2", dataMaturity: 2 as const },
      { ...sampleProfile, name: "Comp3", dataMaturity: 4 as const },
    ];
    const result = benchmarkAgainstIndustry(sampleProfile, industryData);
    expect(result).toHaveProperty("percentile");
    expect(result.percentile).toBeGreaterThanOrEqual(0);
    expect(result.percentile).toBeLessThanOrEqual(100);
  });

  it("benchmarkAgainstIndustry handles empty industry data", () => {
    const benchmarkAgainstIndustry = assessment.benchmarkAgainstIndustry || assessment.default?.benchmarkAgainstIndustry;
    const result = benchmarkAgainstIndustry(sampleProfile, []);
    expect(result.percentile).toBe(0);
  });
});

describe("Recommendation", () => {
  it("generateRecommendations returns array of recommendations", () => {
    const assessAIReadiness = assessment.assessAIReadiness || assessment.default?.assessAIReadiness;
    const generateRecommendations = recommendation.generateRecommendations || recommendation.default?.generateRecommendations;
    const report = assessAIReadiness(sampleProfile);
    const recs = generateRecommendations(report, 75000);
    expect(Array.isArray(recs)).toBe(true);
    expect(recs.length).toBeGreaterThan(0);
    expect(recs[0]).toHaveProperty("title");
    expect(recs[0]).toHaveProperty("impact");
    expect(recs[0]).toHaveProperty("effort");
    expect(recs[0]).toHaveProperty("estimatedROI");
    expect(recs[0]).toHaveProperty("timelineWeeks");
  });

  it("prioritize by roi sorts descending by estimatedROI", () => {
    const prioritize = recommendation.prioritize || recommendation.default?.prioritize;
    const recs = [
      { title: "A", impact: "low", effort: "low", estimatedROI: 10000, timelineWeeks: 4, description: "", dependencies: [] },
      { title: "B", impact: "high", effort: "high", estimatedROI: 50000, timelineWeeks: 12, description: "", dependencies: [] },
      { title: "C", impact: "medium", effort: "medium", estimatedROI: 25000, timelineWeeks: 8, description: "", dependencies: [] },
    ];
    const sorted = prioritize(recs, "roi");
    expect(sorted[0].title).toBe("B");
    expect(sorted[1].title).toBe("C");
    expect(sorted[2].title).toBe("A");
  });

  it("prioritize by speed sorts ascending by timelineWeeks", () => {
    const prioritize = recommendation.prioritize || recommendation.default?.prioritize;
    const recs = [
      { title: "A", impact: "low", effort: "low", estimatedROI: 10000, timelineWeeks: 12, description: "", dependencies: [] },
      { title: "B", impact: "high", effort: "high", estimatedROI: 50000, timelineWeeks: 4, description: "", dependencies: [] },
    ];
    const sorted = prioritize(recs, "speed");
    expect(sorted[0].title).toBe("B");
  });

  it("estimateTotalCost returns cost, timeline, expectedROI", () => {
    const estimateTotalCost = recommendation.estimateTotalCost || recommendation.default?.estimateTotalCost;
    const recs = [
      { title: "A", timelineWeeks: 4, estimatedROI: 20000, dependencies: [], impact: "high", effort: "low", description: "" },
      { title: "B", timelineWeeks: 8, estimatedROI: 30000, dependencies: [], impact: "medium", effort: "medium", description: "" },
    ];
    const result = estimateTotalCost(recs);
    expect(result).toHaveProperty("cost");
    expect(result).toHaveProperty("timeline");
    expect(result).toHaveProperty("expectedROI");
    expect(result.cost).toBeGreaterThan(0);
    expect(result.expectedROI).toBe(50000);
  });
});

describe("Roadmap", () => {
  it("generateRoadmap returns array of phases", () => {
    const generateRoadmap = roadmap.generateRoadmap || roadmap.default?.generateRoadmap;
    const recs = [
      { title: "Data Cleanup", timelineWeeks: 4, estimatedROI: 10000, dependencies: [], impact: "high", effort: "low", description: "" },
      { title: "ML Pipeline", timelineWeeks: 8, estimatedROI: 30000, dependencies: ["Data Cleanup"], impact: "high", effort: "high", description: "" },
      { title: "Monitoring", timelineWeeks: 3, estimatedROI: 5000, dependencies: ["ML Pipeline"], impact: "medium", effort: "low", description: "" },
    ];
    const phases = generateRoadmap(recs, "2026-04-01");
    expect(Array.isArray(phases)).toBe(true);
    expect(phases.length).toBeGreaterThan(0);
    expect(phases[0]).toHaveProperty("name");
    expect(phases[0]).toHaveProperty("startDate");
    expect(phases[0]).toHaveProperty("endDate");
    expect(phases[0]).toHaveProperty("milestones");
  });

  it("roadmap dates are valid ISO strings", () => {
    const generateRoadmap = roadmap.generateRoadmap || roadmap.default?.generateRoadmap;
    const recs = [
      { title: "Step 1", timelineWeeks: 4, estimatedROI: 10000, dependencies: [], impact: "high", effort: "low", description: "" },
    ];
    const phases = generateRoadmap(recs, "2026-04-01");
    for (const phase of phases) {
      expect(new Date(phase.startDate).toISOString()).toContain("2026");
      expect(new Date(phase.endDate).toISOString()).toBeDefined();
    }
  });

  it("toGanttData returns flat task list", () => {
    const generateRoadmap = roadmap.generateRoadmap || roadmap.default?.generateRoadmap;
    const toGanttData = roadmap.toGanttData || roadmap.default?.toGanttData;
    const recs = [
      { title: "Step 1", timelineWeeks: 4, estimatedROI: 10000, dependencies: [], impact: "high", effort: "low", description: "" },
    ];
    const phases = generateRoadmap(recs, "2026-04-01");
    const gantt = toGanttData(phases);
    expect(gantt).toHaveProperty("tasks");
    expect(Array.isArray(gantt.tasks)).toBe(true);
  });

  it("toMarkdown returns formatted string with phase headers", () => {
    const generateRoadmap = roadmap.generateRoadmap || roadmap.default?.generateRoadmap;
    const toMarkdown = roadmap.toMarkdown || roadmap.default?.toMarkdown;
    const recs = [
      { title: "Step 1", timelineWeeks: 4, estimatedROI: 10000, dependencies: [], impact: "high", effort: "low", description: "" },
    ];
    const phases = generateRoadmap(recs, "2026-04-01");
    const md = toMarkdown(phases);
    expect(typeof md).toBe("string");
    expect(md).toContain("##");
  });
});
