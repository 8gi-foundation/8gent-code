/**
 * Tests for role-config: defaults, round-trip, atomic write.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import {
  loadRoleConfig,
  saveRoleConfig,
  defaultRoleConfig,
  type RoleConfig,
} from "./role-config";

let tempDir: string;
let originalPlatform: PropertyDescriptor | undefined;
let originalArch: PropertyDescriptor | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "role-config-test-"));
  process.env.EIGHT_ROLE_CONFIG_DIR = tempDir;
  originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  originalArch = Object.getOwnPropertyDescriptor(process, "arch");
});

afterEach(() => {
  delete process.env.EIGHT_ROLE_CONFIG_DIR;
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
  if (originalArch) Object.defineProperty(process, "arch", originalArch);
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function setPlatform(platform: NodeJS.Platform, arch: string) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  Object.defineProperty(process, "arch", { value: arch, configurable: true });
}

describe("defaultRoleConfig", () => {
  test("linux defaults to ollama qwen3:14b for all roles", () => {
    setPlatform("linux", "x64");
    const cfg = defaultRoleConfig();
    expect(cfg.schemaVersion).toBe(1);
    expect(cfg.orchestrator).toEqual({ provider: "ollama", model: "qwen3:14b" });
    expect(cfg.engineer).toEqual({ provider: "ollama", model: "qwen3:14b" });
    expect(cfg.qa).toEqual({ provider: "ollama", model: "qwen3:14b" });
    expect(cfg.fallback).toEqual({ provider: "ollama", model: "qwen3:14b" });
  });

  test("darwin x64 (intel) also defaults to ollama qwen3:14b", () => {
    setPlatform("darwin", "x64");
    const cfg = defaultRoleConfig();
    expect(cfg.orchestrator.provider).toBe("ollama");
    expect(cfg.orchestrator.model).toBe("qwen3:14b");
  });

  test("darwin arm64 without apple-foundation bridge defaults to 8gent eight-1.0-q3:14b", () => {
    setPlatform("darwin", "arm64");
    // isAppleFoundationAvailable() checks ~/.8gent/bin/apple-foundation-bridge
    // which does not exist in our temp dir setup, so it returns false here.
    const bridgePath = path.join(os.homedir(), ".8gent", "bin", "apple-foundation-bridge");
    const bridgeExists = fs.existsSync(bridgePath);
    const cfg = defaultRoleConfig();
    if (bridgeExists) {
      // On a host where the bridge really is installed, apple-foundation wins.
      expect(cfg.orchestrator.provider).toBe("apple-foundation");
      expect(cfg.orchestrator.model).toBe("apple-foundation-system");
    } else {
      expect(cfg.orchestrator.provider).toBe("8gent");
      expect(cfg.orchestrator.model).toBe("eight-1.0-q3:14b");
    }
  });
});

describe("loadRoleConfig", () => {
  test("returns defaults when roles.json is absent", () => {
    setPlatform("linux", "x64");
    const cfg = loadRoleConfig();
    expect(cfg).toEqual(defaultRoleConfig());
  });

  test("returns defaults when roles.json is malformed JSON", () => {
    setPlatform("linux", "x64");
    fs.writeFileSync(path.join(tempDir, "roles.json"), "{ not valid json");
    const cfg = loadRoleConfig();
    expect(cfg).toEqual(defaultRoleConfig());
  });

  test("returns defaults when roles.json fails schema validation", () => {
    setPlatform("linux", "x64");
    fs.writeFileSync(path.join(tempDir, "roles.json"), JSON.stringify({ schemaVersion: 999 }));
    const cfg = loadRoleConfig();
    expect(cfg).toEqual(defaultRoleConfig());
  });
});

describe("saveRoleConfig round-trip", () => {
  test("saving then loading returns deeply equal config", () => {
    setPlatform("linux", "x64");
    const cfg: RoleConfig = {
      schemaVersion: 1,
      orchestrator: { provider: "openrouter", model: "anthropic/claude-3.5-sonnet" },
      engineer: { provider: "ollama", model: "qwen3:14b" },
      qa: { provider: "groq", model: "llama-3.1-70b-versatile" },
      fallback: { provider: "ollama", model: "qwen3:14b" },
    };
    saveRoleConfig(cfg);
    expect(fs.existsSync(path.join(tempDir, "roles.json"))).toBe(true);
    const loaded = loadRoleConfig();
    expect(loaded).toEqual(cfg);
  });

  test("creates config dir if missing", () => {
    const nested = path.join(tempDir, "nested", "dir");
    process.env.EIGHT_ROLE_CONFIG_DIR = nested;
    const cfg = defaultRoleConfig();
    saveRoleConfig(cfg);
    expect(fs.existsSync(path.join(nested, "roles.json"))).toBe(true);
  });
});

describe("atomic write", () => {
  test("a valid roles.json survives a simulated crash mid-save", () => {
    setPlatform("linux", "x64");
    // Write a known-good baseline first.
    const baseline: RoleConfig = {
      schemaVersion: 1,
      orchestrator: { provider: "ollama", model: "qwen3:14b" },
      engineer: { provider: "ollama", model: "qwen3:14b" },
      qa: { provider: "ollama", model: "qwen3:14b" },
      fallback: { provider: "ollama", model: "qwen3:14b" },
    };
    saveRoleConfig(baseline);
    const finalPath = path.join(tempDir, "roles.json");
    const baselineContent = fs.readFileSync(finalPath, "utf-8");

    // Simulate a crash: write garbage into the .tmp file but never rename.
    fs.writeFileSync(path.join(tempDir, "roles.json.tmp"), "CRASHED MID-WRITE");

    // The real file is untouched.
    expect(fs.readFileSync(finalPath, "utf-8")).toBe(baselineContent);

    // Load still returns the baseline, not the garbage.
    const loaded = loadRoleConfig();
    expect(loaded).toEqual(baseline);
  });

  test("rename replaces the old file in one step", () => {
    setPlatform("linux", "x64");
    const first: RoleConfig = {
      schemaVersion: 1,
      orchestrator: { provider: "ollama", model: "qwen3:14b" },
      engineer: { provider: "ollama", model: "qwen3:14b" },
      qa: { provider: "ollama", model: "qwen3:14b" },
      fallback: { provider: "ollama", model: "qwen3:14b" },
    };
    saveRoleConfig(first);

    const second: RoleConfig = {
      ...first,
      engineer: { provider: "groq", model: "llama-3.1-70b-versatile" },
    };
    saveRoleConfig(second);

    const loaded = loadRoleConfig();
    expect(loaded.engineer.provider).toBe("groq");
    // No stray tmp file left behind.
    expect(fs.existsSync(path.join(tempDir, "roles.json.tmp"))).toBe(false);
  });
});
