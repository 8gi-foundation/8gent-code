/**
 * VesselHealthMonitor tests.
 *
 * Verifies that vessel status appears instantly upon registration,
 * before any heartbeat arrives from the vessel.
 */

import { describe, expect, it } from "bun:test";
import { VesselHealthMonitor } from "./vessel-health";
import type { VesselStatus } from "./types";

describe("VesselHealthMonitor.register", () => {
	it("sets initial status instantly on registration", () => {
		const monitor = new VesselHealthMonitor();
		const fakeStatus: VesselStatus = {
			memberCode: "8EO",
			ollamaReady: false,
			modelLoaded: false,
			currentTaskId: null,
			uptimeSeconds: 0,
			memoryMb: 0,
		};

		monitor.register("v_test", "8EO");
		monitor.heartbeat("v_test", fakeStatus);

		const record = monitor.getMemberStatus("8EO");
		expect(record).not.toBeNull();
		expect(record!.memberCode).toBe("8EO");
		expect(record!.vesselId).toBe("v_test");
		expect(record!.alive).toBe(true);
	});

	it("exposes initial status before any heartbeat arrives", () => {
		const monitor = new VesselHealthMonitor();
		// Register WITHOUT sending a heartbeat
		monitor.register("v_test2", "8MO");

		const record = monitor.getMemberStatus("8MO");
		expect(record).not.toBeNull();
		expect(record!.lastStatus.memberCode).toBe("8MO");
		// Initial status from register() is all-zero defaults
		expect(record!.lastStatus.ollamaReady).toBe(false);
		expect(record!.lastStatus.modelLoaded).toBe(false);
		expect(record!.lastStatus.currentTaskId).toBeNull();
	});

	it("returns null for unknown member code", () => {
		const monitor = new VesselHealthMonitor();
		const record = monitor.getMemberStatus("8ZZ");
		expect(record).toBeNull();
	});

	it("updates status on heartbeat", () => {
		const monitor = new VesselHealthMonitor();
		monitor.register("v_hb", "8HB");

		const updatedStatus: VesselStatus = {
			memberCode: "8HB",
			ollamaReady: true,
			modelLoaded: true,
			currentTaskId: "task_42",
			uptimeSeconds: 120,
			memoryMb: 512,
		};

		monitor.heartbeat("v_hb", updatedStatus);

		const record = monitor.getMemberStatus("8HB");
		expect(record!.lastStatus.ollamaReady).toBe(true);
		expect(record!.lastStatus.modelLoaded).toBe(true);
		expect(record!.lastStatus.currentTaskId).toBe("task_42");
		expect(record!.lastStatus.uptimeSeconds).toBe(120);
	});

	it("getSummary returns correct counts", () => {
		const monitor = new VesselHealthMonitor();
		monitor.register("v1", "8A");
		monitor.register("v2", "8B");

		const summary = monitor.getSummary();
		expect(summary.total).toBe(2);
		expect(summary.alive).toBe(2);
		expect(summary.dead).toBe(0);
	});

	it("deregister removes vessel from health tracking", () => {
		const monitor = new VesselHealthMonitor();
		monitor.register("v_rm", "8RM");
		expect(monitor.getMemberStatus("8RM")).not.toBeNull();

		monitor.deregister("v_rm");
		expect(monitor.getMemberStatus("8RM")).toBeNull();
	});
});