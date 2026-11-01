/**
 * Reference fake device for the 8DK tests: a desk lamp.
 *
 * One sensor (read the light), one actuator (set the light), and one actuator
 * marked `confirm` (strobe), which must ask the person on every call. It is the
 * smallest device that exercises every branch of the contract. It is a test
 * fixture, never registered on a real vessel.
 */
import { defineDevice } from "../manifest";

export function createFakeLamp(id = "desk-lamp") {
	const state = { on: false, brightness: 0, calls: [] as string[] };
	const device = defineDevice(
		{
			id,
			name: "Desk lamp",
			kind: "lamp",
			version: "0.1.0",
			capabilities: [
				{
					name: "read_light",
					kind: "sensor",
					description: "Read whether the lamp is on and its brightness (0-100).",
				},
				{
					name: "set_light",
					kind: "actuator",
					description: "Turn the lamp on or off and set its brightness.",
					params: {
						on: { type: "boolean", required: true, description: "true for on" },
						brightness: { type: "number", description: "0-100" },
					},
				},
				{
					name: "strobe",
					kind: "actuator",
					description: "Flash the lamp rapidly. Asks the person every time.",
					confirm: true,
				},
			],
		},
		{
			read_light: () => {
				state.calls.push("read_light");
				return { on: state.on, brightness: state.brightness };
			},
			set_light: (input) => {
				state.calls.push("set_light");
				state.on = input.on as boolean;
				if (typeof input.brightness === "number") state.brightness = input.brightness;
				return { on: state.on, brightness: state.brightness };
			},
			strobe: () => {
				state.calls.push("strobe");
				return { strobed: true };
			},
		},
	);
	return { device, state };
}
