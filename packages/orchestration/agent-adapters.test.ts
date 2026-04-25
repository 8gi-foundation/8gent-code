/**
 * Tests for agent-adapters: vendor-neutral labels and the legacy
 * adapter-name migration shim. See issue #1819.
 */

import { test, expect, describe } from "bun:test";

import {
  getAdapter,
  getAdapters,
  migrateAdapterName,
  hostCliPrimaryAdapter,
  hostCliSecondaryAdapter,
  hostCliTertiaryAdapter,
  eightAdapter,
  // Deprecated aliases retained for backward compatibility.
  claudeCodeAdapter,
  codexAdapter,
  openCodeAdapter,
} from "./agent-adapters";

describe("agent-adapters generic labels", () => {
  test("registry exposes only generic adapter names", () => {
    const names = getAdapters().map((a) => a.name).sort();
    expect(names).toEqual(
      [
        "8gent",
        "host-cli-primary",
        "host-cli-secondary",
        "host-cli-tertiary",
      ].sort(),
    );
  });

  test("each generic adapter resolves via getAdapter()", () => {
    expect(getAdapter("host-cli-primary")?.name).toBe("host-cli-primary");
    expect(getAdapter("host-cli-secondary")?.name).toBe("host-cli-secondary");
    expect(getAdapter("host-cli-tertiary")?.name).toBe("host-cli-tertiary");
    expect(getAdapter("8gent")?.name).toBe("8gent");
  });

  test("unknown adapter name returns null", () => {
    expect(getAdapter("does-not-exist")).toBeNull();
  });
});

describe("agent-adapters legacy migration shim", () => {
  test("migrateAdapterName maps legacy labels to current ones", () => {
    expect(migrateAdapterName("claude-code")).toBe("host-cli-primary");
    expect(migrateAdapterName("codex")).toBe("host-cli-secondary");
    expect(migrateAdapterName("opencode")).toBe("host-cli-tertiary");
  });

  test("migrateAdapterName passes through current labels untouched", () => {
    expect(migrateAdapterName("host-cli-primary")).toBe("host-cli-primary");
    expect(migrateAdapterName("8gent")).toBe("8gent");
    expect(migrateAdapterName("unknown-future-label")).toBe("unknown-future-label");
  });

  test("getAdapter() accepts legacy names via the shim", () => {
    expect(getAdapter("claude-code")?.name).toBe("host-cli-primary");
    expect(getAdapter("codex")?.name).toBe("host-cli-secondary");
    expect(getAdapter("opencode")?.name).toBe("host-cli-tertiary");
  });

  test("deprecated adapter exports still point at current adapters", () => {
    expect(claudeCodeAdapter).toBe(hostCliPrimaryAdapter);
    expect(codexAdapter).toBe(hostCliSecondaryAdapter);
    expect(openCodeAdapter).toBe(hostCliTertiaryAdapter);
  });

  test("8gent self adapter is always available", async () => {
    expect(eightAdapter.name).toBe("8gent");
    expect(await eightAdapter.isAvailable()).toBe(true);
  });
});
