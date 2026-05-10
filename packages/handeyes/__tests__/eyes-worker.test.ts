/**
 * Eyes worker tests per spec §5.2.
 *
 * Covers:
 *   - The worker subscribes to eyes.observe() exactly once
 *   - ObservationEvents are published to the bus under the session-scoped
 *     event name (so two parallel sessions on the same bus don't collide)
 *   - stop() disposes the underlying eyes subscription and is idempotent
 *   - Events emitted after stop() are NOT published (no late writes)
 */

import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { ObservationEvent } from "@8gent/eyes";
import { observationEventName, startEyesWorker } from "../eyes-worker.js";

class FakeBus extends EventEmitter {}

function fakeEyes() {
	let handler: ((e: ObservationEvent) => void) | null = null;
	let disposed = false;
	const eyes = {
		id: "fake",
		available: true,
		backend: "fake",
		async capture() {
			throw new Error("not used");
		},
		async captureAll() {
			return [];
		},
		async annotate(f: unknown) {
			return f as never;
		},
		async locate() {
			return [];
		},
		async describe() {
			return { summary: "" };
		},
		async wait_for() {
			return { ok: true, elapsedMs: 0 } as never;
		},
		async diff() {
			return { similarity: 1.0, regions: [], pixelsDifferent: 0 };
		},
		observe(h: (e: ObservationEvent) => void) {
			handler = h;
			return {
				dispose: () => {
					disposed = true;
				},
			};
		},
	} as unknown as Parameters<typeof startEyesWorker>[0]["eyes"];
	return {
		eyes,
		fire: (e: ObservationEvent) => handler?.(e),
		isDisposed: () => disposed,
	};
}

function fakeEvent(similarity: number): ObservationEvent {
	return {
		at: Date.now(),
		diff: { similarity, regions: [], pixelsDifferent: 0 },
		frame: {
			id: "f",
			path: "",
			width: 1,
			height: 1,
			displayId: 1,
			capturedAt: 0,
			scale: 1,
			platform: "darwin",
		} as unknown as ObservationEvent["frame"],
	};
}

describe("eyes worker", () => {
	it("publishes observe events to the session-scoped bus channel", async () => {
		const { eyes, fire } = fakeEyes();
		const bus = new FakeBus();
		const events: ObservationEvent[] = [];
		bus.on(observationEventName("sess-1"), (e: ObservationEvent) => events.push(e));

		const worker = startEyesWorker({
			eyes,
			bus: bus as unknown as Parameters<typeof startEyesWorker>[0]["bus"],
			sessionId: "sess-1",
		});
		expect(worker.active).toBe(true);

		fire(fakeEvent(0.5));
		fire(fakeEvent(0.3));
		expect(events.length).toBe(2);

		worker.stop();
	});

	it("scopes events by sessionId so parallel sessions do not collide", () => {
		const a = fakeEyes();
		const b = fakeEyes();
		const bus = new FakeBus();
		const aSeen: ObservationEvent[] = [];
		const bSeen: ObservationEvent[] = [];
		bus.on(observationEventName("A"), (e: ObservationEvent) => aSeen.push(e));
		bus.on(observationEventName("B"), (e: ObservationEvent) => bSeen.push(e));

		const wA = startEyesWorker({
			eyes: a.eyes,
			bus: bus as unknown as Parameters<typeof startEyesWorker>[0]["bus"],
			sessionId: "A",
		});
		const wB = startEyesWorker({
			eyes: b.eyes,
			bus: bus as unknown as Parameters<typeof startEyesWorker>[0]["bus"],
			sessionId: "B",
		});

		a.fire(fakeEvent(0.1));
		b.fire(fakeEvent(0.2));

		expect(aSeen.length).toBe(1);
		expect(bSeen.length).toBe(1);

		wA.stop();
		wB.stop();
	});

	it("stop() disposes the underlying subscription and is idempotent", () => {
		const { eyes, isDisposed } = fakeEyes();
		const worker = startEyesWorker({
			eyes,
			bus: new FakeBus() as unknown as Parameters<typeof startEyesWorker>[0]["bus"],
			sessionId: "s",
		});
		expect(isDisposed()).toBe(false);
		worker.stop();
		expect(isDisposed()).toBe(true);
		// Second stop is a no-op.
		worker.stop();
		expect(worker.active).toBe(false);
	});

	it("does not publish events fired after stop()", () => {
		const { eyes, fire } = fakeEyes();
		const bus = new FakeBus();
		const seen: ObservationEvent[] = [];
		bus.on(observationEventName("s"), (e: ObservationEvent) => seen.push(e));

		const worker = startEyesWorker({
			eyes,
			bus: bus as unknown as Parameters<typeof startEyesWorker>[0]["bus"],
			sessionId: "s",
		});
		fire(fakeEvent(0.5));
		expect(seen.length).toBe(1);

		worker.stop();
		// The fake's handler reference is still live (we did not detach it
		// in the disposable in this fake); a real backend's dispose would
		// remove the handler. The worker's own active-guard must drop the
		// post-stop fire.
		fire(fakeEvent(0.6));
		expect(seen.length).toBe(1);
	});
});
