// @ts-nocheck - a Pi extension that calls a session-control API 8gent does not provide.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.sendUserMessage("hello from the factory");
}
