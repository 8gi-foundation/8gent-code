// @ts-nocheck - proves import never runs extension code: loading this file writes a marker.

import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

if (process.env.PI_FIXTURE_MARKER)
	writeFileSync(process.env.PI_FIXTURE_MARKER, "ran at module load");

export default function (pi: ExtensionAPI) {
	if (process.env.PI_FIXTURE_MARKER)
		writeFileSync(`${process.env.PI_FIXTURE_MARKER}.factory`, "factory ran");
	pi.registerCommand("marker", { description: "x", handler: async () => {} });
}
