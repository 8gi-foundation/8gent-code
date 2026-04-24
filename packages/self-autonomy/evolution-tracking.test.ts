/**
 * Tests for structured evolution tracking — event history, skill history,
 * pattern frequency, evolution summary, and schema versioning.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import {
  resetDb,
  recordEvent,
  getSkillHistory,
  getPatternFrequency,
  getEvolutionSummary,
  getSchemaVersion,
  setSchemaVersion,
} from "./evolution-db";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-test-"));
  process.env.EIGHT_DATA_DIR = tmpDir;
  resetDb();
});

afterEach(() => {
  resetDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.EIGHT_DATA_DIR;
});

// ============================================
// recordEvent
// ============================================

describe("recordEvent", () => {
  it("stores a structured event and returns an ID", () => {
    const id = recordEvent({
      sessionId: "sess-001",
      eventType: "skill_learned",
      subject: "docker-compose",
      value: 0.8,
    });

    expect(id).toBeString();
    expect(id.startsWith("evt_")).toBe(true);
  });

  it("generates unique IDs for each event", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      ids.add(
        recordEvent({
          sessionId: "sess-uniq",
          eventType: "skill_used",
          subject: "test-skill",
        }),
      );
    }
    expect(ids.size).toBe(50);
  });

  it("stores metadata as JSON correctly", () => {
    const meta = { tool: "grep", exitCode: 0, flags: ["--recursive"] };
    recordEvent({
      sessionId: "sess-meta",
      eventType: "pattern_discovered",
      subject: "recursive-search",
      metadata: meta,
    });

    const freq = getPatternFrequency("recursive-search");
    expect(freq.count).toBe(1);
  });
});

// ============================================
// getSkillHistory
// ============================================

describe("getSkillHistory", () => {
  it("returns confidence changes in chronological order", () => {
    recordEvent({
      sessionId: "sess-a",
      eventType: "confidence_change",
      subject: "skill-docker",
      value: 0.5,
    });

    recordEvent({
      sessionId: "sess-b",
      eventType: "confidence_change",
      subject: "skill-docker",
      value: 0.7,
    });

    recordEvent({
      sessionId: "sess-c",
      eventType: "confidence_change",
      subject: "skill-docker",
      value: 0.9,
    });

    const history = getSkillHistory("skill-docker");
    expect(history).toHaveLength(3);
    expect(history[0].confidence).toBe(0.5);
    expect(history[1].confidence).toBe(0.7);
    expect(history[2].confidence).toBe(0.9);
    for (let i = 1; i < history.length; i++) {
      expect(history[i].timestamp >= history[i - 1].timestamp).toBe(true);
    }
  });

  it("returns empty array for unknown skill", () => {
    const history = getSkillHistory("nonexistent-skill");
    expect(history).toEqual([]);
  });
});

// ============================================
// getPatternFrequency
// ============================================

describe("getPatternFrequency", () => {
  it("tracks first/last seen and count", () => {
    recordEvent({
      sessionId: "sess-p1",
      eventType: "pattern_discovered",
      subject: "retry-on-timeout",
    });
    recordEvent({
      sessionId: "sess-p2",
      eventType: "pattern_discovered",
      subject: "retry-on-timeout",
    });
    recordEvent({
      sessionId: "sess-p3",
      eventType: "pattern_discovered",
      subject: "retry-on-timeout",
    });

    const freq = getPatternFrequency("retry-on-timeout");
    expect(freq.count).toBe(3);
    expect(freq.firstSeen).toBeString();
    expect(freq.lastSeen).toBeString();
    expect(freq.firstSeen <= freq.lastSeen).toBe(true);
    expect(freq.sessions).toContain("sess-p1");
    expect(freq.sessions).toContain("sess-p2");
    expect(freq.sessions).toContain("sess-p3");
  });

  it("returns count=0 for unknown pattern", () => {
    const freq = getPatternFrequency("does-not-exist");
    expect(freq.count).toBe(0);
    expect(freq.sessions).toEqual([]);
    expect(freq.firstSeen).toBe("");
    expect(freq.lastSeen).toBe("");
  });
});

// ============================================
// getEvolutionSummary
// ============================================

describe("getEvolutionSummary", () => {
  it("counts new skills and patterns since date", () => {
    const since = new Date(Date.now() - 60_000).toISOString();

    recordEvent({
      sessionId: "sess-s1",
      eventType: "skill_learned",
      subject: "new-skill-a",
    });
    recordEvent({
      sessionId: "sess-s2",
      eventType: "skill_learned",
      subject: "new-skill-b",
    });
    recordEvent({
      sessionId: "sess-s3",
      eventType: "pattern_discovered",
      subject: "pattern-x",
    });

    const summary = getEvolutionSummary(since);
    expect(summary.newSkills).toBe(2);
    expect(summary.newPatterns).toBe(1);
  });

  it("calculates error rate correctly", () => {
    const since = new Date(Date.now() - 60_000).toISOString();

    recordEvent({
      sessionId: "sess-e1",
      eventType: "skill_used",
      subject: "skill-a",
    });
    recordEvent({
      sessionId: "sess-e2",
      eventType: "error_encountered",
      subject: "timeout-error",
    });
    recordEvent({
      sessionId: "sess-e3",
      eventType: "skill_used",
      subject: "skill-b",
    });

    const summary = getEvolutionSummary(since);
    expect(summary.errorRate).toBeCloseTo(1 / 3, 4);
  });
});

// ============================================
// Schema versioning
// ============================================

describe("schema versioning", () => {
  it("getSchemaVersion returns 1 for fresh DB", () => {
    const version = getSchemaVersion();
    expect(version).toBe(1);
  });

  it("setSchemaVersion updates and persists the version", () => {
    setSchemaVersion(2);
    expect(getSchemaVersion()).toBe(2);

    // Reset and reopen — version should persist
    resetDb();
    expect(getSchemaVersion()).toBe(2);
  });
});
