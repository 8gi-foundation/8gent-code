// @ts-nocheck - a Pi extension using a Pi API 8gent does not provide (a terminal editor component).
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("edit-fancy", { handler: async () => void new CustomEditor() });
}
