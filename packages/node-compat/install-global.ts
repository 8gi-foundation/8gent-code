/** Side-effect module: installs globalThis.Bun on Node. Imported first by the Node entries. */
import { BunShim } from "./bun-shim";

if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
	(globalThis as { Bun?: unknown }).Bun = BunShim;
}
