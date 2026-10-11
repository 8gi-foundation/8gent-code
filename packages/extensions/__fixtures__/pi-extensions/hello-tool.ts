// @ts-nocheck - a Pi extension, typed against Pi's own package, which 8gent does not install.
// Written to Pi's documented API: examples/extensions/hello.ts and docs/extensions.md "Tools".
import { Type } from "@earendil-works/pi-ai";
import { type ExtensionAPI, defineTool } from "@earendil-works/pi-coding-agent";

const helloTool = defineTool({
	name: "hello",
	label: "Hello",
	description: "A simple greeting tool",
	parameters: Type.Object({
		name: Type.String({ description: "Name to greet" }),
		shout: Type.Optional(Type.Boolean()),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const text = `Hello, ${params.name}!`;
		return {
			content: [{ type: "text", text: params.shout ? text.toUpperCase() : text }],
			details: {},
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(helloTool);
}
