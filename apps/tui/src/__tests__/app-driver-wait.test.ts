/**
 * waitFor must not read the harness's clock. once-notices.harness freezes
 * Date.now to minute resolution; a minute boundary crossed during boot then
 * looked like 60 s elapsed and failed "setup placeholder" at once (#4060 CI).
 */
import { expect, test } from "bun:test";
import { waitFor } from "./app-driver.js";

test("waitFor still waits when Date.now jumps a minute", async () => {
	const real = Date.now;
	let calls = 0;
	Date.now = () => real() + (calls++ > 2 ? 60_000 : 0);
	try {
		let ready = false;
		setTimeout(() => {
			ready = true;
		}, 200);
		await waitFor(() => ready, "ready");
		expect(ready).toBe(true);
	} finally {
		Date.now = real;
	}
});
