/**
 * VesselHealth - Heartbeat aggregation and alerting for board vessels.
 *
 * Tracks vessel heartbeats, detects stale/dead vessels, and provides
 * aggregated health status for the /health endpoint and monitoring.
 */

import type { VesselStatus } from "./types";

export interface VesselHealthRecord {
  vesselId: string;
  memberCode: string;
  lastHeartbeat: number;
  lastStatus: VesselStatus;
  connectedAt: number;
  missedHeartbeats: number;
  alive: boolean;
}

const HEARTBEAT_TIMEOUT_MS = 90_000; // 3 missed 30s heartbeats
const MAX_MISSED_HEARTBEATS = 3;

export class VesselHealthMonitor {
  private vessels: Map<string, VesselHealthRecord> = new Map();
  private onAlert: ((msg: string) => void) | null = null;

  constructor(alertHandler?: (msg: string) => void) {
    this.onAlert = alertHandler ?? null;
  }

  /** Register a new vessel connection */
  register(vesselId: string, memberCode: string): void {
    const now = Date.now();
    this.vessels.set(vesselId, {
      vesselId,
      memberCode,
      lastHeartbeat: now,
      lastStatus: {
        memberCode,
        ollamaReady: false,
        modelLoaded: false,
        currentTaskId: null,
        uptimeSeconds: 0,
        memoryMb: 0,
      },
      connectedAt: now,
      missedHeartbeats: 0,
      alive: true,
    });
    console.log(`[vessel-health] registered ${vesselId} (${memberCode})`);
  }

  /** Update vessel status from heartbeat */
  heartbeat(vesselId: string, status: VesselStatus): void {
    const record = this.vessels.get(vesselId);
    if (!record) return;
    record.lastHeartbeat = Date.now();
    record.lastStatus = status;
    record.missedHeartbeats = 0;
    record.alive = true;
  }

  /** Remove a vessel (disconnected) */
  deregister(vesselId: string): void {
    const record = this.vessels.get(vesselId);
    if (record) {
      console.log(`[vessel-health] deregistered ${vesselId} (${record.memberCode})`);
      this.onAlert?.(`Vessel ${vesselId} (${record.memberCode}) disconnected`);
    }
    this.vessels.delete(vesselId);
  }

  /** Check all vessels for staleness - call this on an interval */
  check(): string[] {
    const now = Date.now();
    const alerts: string[] = [];

    for (const [id, record] of this.vessels) {
      const elapsed = now - record.lastHeartbeat;

      if (elapsed > HEARTBEAT_TIMEOUT_MS) {
        record.missedHeartbeats++;
        record.alive = false;

        if (record.missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
          const msg = `Vessel ${id} (${record.memberCode}) dead - ${record.missedHeartbeats} missed heartbeats`;
          alerts.push(msg);
          this.onAlert?.(msg);
        }
      }
    }

    return alerts;
  }

  /** Get health summary for all vessels */
  getSummary(): {
    total: number;
    alive: number;
    dead: number;
    vessels: VesselHealthRecord[];
  } {
    const records = Array.from(this.vessels.values());
    const alive = records.filter((r) => r.alive).length;
    return {
      total: records.length,
      alive,
      dead: records.length - alive,
      vessels: records,
    };
  }

  /** Get status for a specific member code */
  getMemberStatus(memberCode: string): VesselHealthRecord | null {
    for (const record of this.vessels.values()) {
      if (record.memberCode === memberCode) return record;
    }
    return null;
  }
}
