/**
 * AgentMesh - basic join/leave/messaging tests
 *
 * Covers: constructor, join, leave, listPeers, send, consume, broadcast.
 * Uses real filesystem IPC under a temp MESH_DIR.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { AgentMesh, type MeshAgent, type MeshMessage } from "./agent-mesh.js";
import { rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Override the mesh directory to isolate tests
const TEST_MESH_DIR = join(tmpdir(), `mesh-test-${Date.now()}`);

function createMesh(name: string, type: MeshAgent["type"] = "eight"): AgentMesh {
  return new AgentMesh({
    type,
    name,
    pid: process.pid,
    cwd: process.cwd(),
    capabilities: ["code"],
  });
}

describe("AgentMesh", () => {
  let meshA: AgentMesh;
  let meshB: AgentMesh;

  beforeEach(() => {
    meshA = createMesh("agent-a");
    meshB = createMesh("agent-b");
  });

  afterEach(() => {
    try {
      meshA.leave();
    } catch {}
    try {
      meshB.leave();
    } catch {}
  });

  test("constructor assigns a unique agentId", () => {
    expect(meshA.agentId).toBeDefined();
    expect(meshB.agentId).toBeDefined();
    expect(meshA.agentId).not.toBe(meshB.agentId);
  });

  test("join registers agent in the mesh", () => {
    meshA.join();
    const peers = meshA.listAllAgents();
    const self = peers.find((a) => a.id === meshA.agentId);
    expect(self).toBeDefined();
    expect(self!.name).toBe("agent-a");
  });

  test("two agents see each other as peers", () => {
    meshA.join();
    meshB.join();

    const peersOfA = meshA.listPeers();
    expect(peersOfA.some((p) => p.id === meshB.agentId)).toBe(true);

    const peersOfB = meshB.listPeers();
    expect(peersOfB.some((p) => p.id === meshA.agentId)).toBe(true);
  });

  test("leave removes agent from registry", () => {
    meshA.join();
    meshB.join();
    meshA.leave();

    const peersOfB = meshB.listPeers();
    expect(peersOfB.some((p) => p.id === meshA.agentId)).toBe(false);
  });

  test("send and consume delivers a message", () => {
    meshA.join();
    meshB.join();

    meshA.send(meshB.agentId, "chat", "hello from A");

    const messages = meshB.consume();
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages.some((m) => m.content === "hello from A")).toBe(true);
  });

  test("consume empties the inbox", () => {
    meshA.join();
    meshB.join();

    meshA.send(meshB.agentId, "chat", "first message");
    meshB.consume(); // drain

    const second = meshB.consume();
    expect(second).toHaveLength(0);
  });

  test("broadcast reaches all peers", () => {
    meshA.join();
    meshB.join();

    meshA.broadcast("event", "system update");

    const msgs = meshB.consume();
    expect(msgs.some((m) => m.content === "system update")).toBe(true);
  });
});
