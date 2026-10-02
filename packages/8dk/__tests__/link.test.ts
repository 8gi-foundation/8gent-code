import { describe, expect, test } from "bun:test";
import { CallCorrelator, type VesselFrame, parseDeviceFrame, serveDevice } from "../link";
import { createFakeLamp } from "./fake-device";

describe("frames", () => {
	test("parses valid device frames and rejects anything else", () => {
		expect(parseDeviceFrame('{"type":"device:result","callId":"c1","ok":true,"result":1}')).toEqual(
			{
				type: "device:result",
				callId: "c1",
				ok: true,
				result: 1,
			},
		);
		expect(parseDeviceFrame("not json")).toBeNull();
		expect(parseDeviceFrame('{"type":"device:invoke","callId":"c1"}')).toBeNull();
		expect(parseDeviceFrame('{"type":"device:result","ok":true}')).toBeNull();
		expect(parseDeviceFrame('{"type":"device:auth","deviceId":"a"}')).toBeNull();
		expect(parseDeviceFrame({ type: "device:hello", manifest: {} })).toEqual({
			type: "device:hello",
			manifest: {},
		});
	});
});

/** Wire a correlator to a device endpoint through JSON strings, as a socket would. */
function wire(handlers = createFakeLamp().device) {
	const correlator = new CallCorrelator((frame: VesselFrame) => {
		queueMicrotask(() => deviceSide(JSON.parse(JSON.stringify(frame))));
	});
	const deviceSide = serveDevice(handlers, (frame) => {
		const parsed = parseDeviceFrame(JSON.stringify(frame));
		if (parsed) correlator.handle(parsed);
	});
	return correlator;
}

describe("call correlation over frames", () => {
	test("an invoke round-trips to the device handler and back", async () => {
		const link = wire();
		expect(await link.invoke("set_light", { on: true, brightness: 70 }, 1000)).toEqual({
			ok: true,
			result: { on: true, brightness: 70 },
		});
	});

	test("a handler that throws comes back as an error, not a crash", async () => {
		const { device } = createFakeLamp();
		const broken = {
			...device,
			handlers: {
				...device.handlers,
				read_light: () => {
					throw new Error("bulb gone");
				},
			},
		};
		const res = await wire(broken).invoke("read_light", {}, 1000);
		expect(res).toEqual({ ok: false, error: "bulb gone" });
	});

	test("an unanswered call times out and a late result is ignored", async () => {
		const sent: VesselFrame[] = [];
		const c = new CallCorrelator((f) => sent.push(f));
		const res = await c.invoke("read_light", {}, 20);
		expect(res).toEqual({ ok: false, error: "device did not answer within 20ms" });
		const callId = (sent[0] as { callId: string }).callId;
		expect(c.handle({ type: "device:result", callId, ok: true, result: 1 })).toBe(false);
	});
});

describe("serveDevice only runs own handlers (8SO F2)", () => {
	// A DeviceDefinition built by hand, as a third-party device might, with an
	// ordinary object of handlers. Inherited names must not resolve to Object.prototype.
	const lamp = createFakeLamp().device;
	const handBuilt = { manifest: lamp.manifest, handlers: { ...lamp.handlers } };

	for (const capability of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
		test(`an invoke for "${capability}" is an unknown capability, not Object(input)`, async () => {
			for (const device of [handBuilt, lamp]) {
				const sent: unknown[] = [];
				const serve = serveDevice(device, (frame) => sent.push(frame));
				await serve({
					type: "device:invoke",
					callId: "c1",
					capability,
					input: { probe: 1 },
				});
				expect(sent).toEqual([
					{
						type: "device:result",
						callId: "c1",
						ok: false,
						error: `unknown capability "${capability}"`,
					},
				]);
			}
		});
	}
});
