import { describe, it, expect, beforeEach } from "bun:test";
import * as path from "path";

const WORK_DIR = process.env.WORK_DIR || path.dirname(process.env.FIXTURE_PATH || ".");

let analyzer: any, scorer: any, reporter: any;

beforeEach(async () => {
  try {
    analyzer = await import(path.join(WORK_DIR, "analyzer.ts"));
    scorer = await import(path.join(WORK_DIR, "scorer.ts"));
    reporter = await import(path.join(WORK_DIR, "reporter.ts"));
  } catch {}
});

describe("SEO Analyzer", () => {
  it("analyzeMeta extracts title, description, h1s from full HTML", () => {
    const analyzeMeta = analyzer.analyzeMeta || analyzer.default?.analyzeMeta;
    const html = `<html><head><title>Test Page</title><meta name="description" content="A test page"></head><body><h1>Main Heading</h1></body></html>`;
    const result = analyzeMeta(html);
    expect(result.title).toBe("Test Page");
    expect(result.description).toBe("A test page");
    expect(result.h1s).toContain("Main Heading");
  });

  it("analyzeMeta reports missing meta tags", () => {
    const analyzeMeta = analyzer.analyzeMeta || analyzer.default?.analyzeMeta;
    const html = `<html><head></head><body><p>No meta</p></body></html>`;
    const result = analyzeMeta(html);
    expect(result.title).toBeFalsy();
    expect(result.description).toBeFalsy();
  });

  it("analyzeContent returns accurate word count", () => {
    const analyzeContent = analyzer.analyzeContent || analyzer.default?.analyzeContent;
    const result = analyzeContent("The quick brown fox jumps over the lazy dog");
    expect(result.wordCount).toBe(9);
  });

  it("analyzeContent returns reading level as number", () => {
    const analyzeContent = analyzer.analyzeContent || analyzer.default?.analyzeContent;
    const result = analyzeContent("This is a simple sentence. Another simple sentence here.");
    expect(typeof result.readingLevel).toBe("number");
  });

  it("analyzeContent calculates keyword density", () => {
    const analyzeContent = analyzer.analyzeContent || analyzer.default?.analyzeContent;
    const result = analyzeContent("test test test other words here", "test");
    expect(result.keywordDensity).toBeGreaterThan(0);
  });

  it("analyzeLinks counts internal vs external links", () => {
    const analyzeLinks = analyzer.analyzeLinks || analyzer.default?.analyzeLinks;
    const html = `<a href="/about">About</a><a href="https://external.com">Ext</a><a href="/contact">Contact</a>`;
    const result = analyzeLinks(html, "https://mysite.com");
    expect(result.internal).toBe(2);
    expect(result.external).toBe(1);
  });

  it("analyzeLinks detects nofollow links", () => {
    const analyzeLinks = analyzer.analyzeLinks || analyzer.default?.analyzeLinks;
    const html = `<a href="https://ext.com" rel="nofollow">Ext</a><a href="/page">Page</a>`;
    const result = analyzeLinks(html, "https://mysite.com");
    expect(result.nofollow).toBe(1);
  });

  it("analyzeContent handles empty string", () => {
    const analyzeContent = analyzer.analyzeContent || analyzer.default?.analyzeContent;
    const result = analyzeContent("");
    expect(result.wordCount).toBe(0);
  });
});

describe("SEO Scorer", () => {
  it("scoreMeta returns score, issues, and recommendations", () => {
    const scoreMeta = scorer.scoreMeta || scorer.default?.scoreMeta;
    const result = scoreMeta({ title: "Great Page Title", description: "A well-written description", h1s: ["Main Heading"] });
    expect(result).toHaveProperty("score");
    expect(result).toHaveProperty("issues");
    expect(result).toHaveProperty("recommendations");
  });

  it("scoreMeta gives high score for good data", () => {
    const scoreMeta = scorer.scoreMeta || scorer.default?.scoreMeta;
    const result = scoreMeta({ title: "Great Page Title", description: "A well-written meta description that is informative", h1s: ["Main Heading"] });
    expect(result.score).toBeGreaterThan(70);
  });

  it("scoreMeta gives low score for missing title", () => {
    const scoreMeta = scorer.scoreMeta || scorer.default?.scoreMeta;
    const result = scoreMeta({ title: "", description: "", h1s: [] });
    expect(result.score).toBeLessThan(50);
  });

  it("scoreContent gives low score for short content", () => {
    const scoreContent = scorer.scoreContent || scorer.default?.scoreContent;
    const result = scoreContent({ wordCount: 50, readingLevel: 8, keywordDensity: 0.02 });
    expect(result.score).toBeLessThan(50);
  });

  it("scorePerformance gives high score for good vitals", () => {
    const scorePerf = scorer.scorePerformance || scorer.default?.scorePerformance;
    const result = scorePerf({ lcp: 1.5, fid: 50, cls: 0.05 });
    expect(result.score).toBeGreaterThan(70);
  });

  it("overallScore returns weighted average", () => {
    const overall = scorer.overallScore || scorer.default?.overallScore;
    const result = overall({ meta: 80, content: 70, performance: 90 });
    expect(typeof result).toBe("number");
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(100);
  });
});

describe("SEO Reporter", () => {
  it("generateAuditReport returns report with grade", () => {
    const genReport = reporter.generateAuditReport || reporter.default?.generateAuditReport;
    const result = genReport({ meta: { score: 80 }, content: { score: 70 }, performance: { score: 90 } });
    expect(result).toHaveProperty("grade");
  });

  it("returns grade A for all high scores", () => {
    const genReport = reporter.generateAuditReport || reporter.default?.generateAuditReport;
    const result = genReport({ meta: { score: 95 }, content: { score: 90 }, performance: { score: 95 } });
    expect(result.grade).toBe("A");
  });

  it("returns grade F for all low scores", () => {
    const genReport = reporter.generateAuditReport || reporter.default?.generateAuditReport;
    const result = genReport({ meta: { score: 10 }, content: { score: 5 }, performance: { score: 15 } });
    expect(result.grade).toBe("F");
  });
});
