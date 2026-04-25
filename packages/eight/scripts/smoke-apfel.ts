#!/usr/bin/env bun
/**
 * Smoke test: apfel client.
 *
 * Sends a "hello" prompt and prints the first token received.
 * Expects apfel to be running at $APFEL_BASE_URL (default http://localhost:11434/v1).
 *
 * Exit codes:
 *   0 = got a non-empty response
 *   1 = network error / endpoint down (prints install hint)
 *   2 = vision-rejection path (only triggered with --test-vision)
 */

import { ApfelClient } from "../clients/apfel";

async function main() {
  const args = new Set(process.argv.slice(2));

  const client = new ApfelClient("apple-foundation-system");
  const baseUrl = process.env.APFEL_BASE_URL || "http://localhost:11434/v1";
  console.log(`[smoke-apfel] base_url=${baseUrl}`);

  if (args.has("--test-vision")) {
    try {
      await client.chat([
        {
          role: "user",
          content: [
            { type: "text", text: "What's in this image?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ]);
      console.error("[smoke-apfel] FAIL: vision prompt should have been rejected");
      process.exit(2);
    } catch (err) {
      console.log(`[smoke-apfel] vision-rejection OK: ${(err as Error).message}`);
      process.exit(0);
    }
  }

  const reachable = await client.isAvailable();
  if (!reachable) {
    console.error(
      `[smoke-apfel] endpoint not reachable at ${baseUrl}. ` +
        `Install apfel: https://github.com/Arthur-Ficial/apfel and start it ` +
        `(recommended: \`apfel serve --port 11500\` then \`export APFEL_BASE_URL=http://localhost:11500/v1\`).`,
    );
    process.exit(1);
  }

  try {
    const response = await client.chat([
      { role: "user", content: "Say hello in one word." },
    ]);
    const content = response.message.content || "";
    if (!content.trim()) {
      console.error("[smoke-apfel] FAIL: empty response");
      process.exit(1);
    }
    console.log(`[smoke-apfel] response: ${content.slice(0, 200)}`);
    console.log(`[smoke-apfel] OK`);
    process.exit(0);
  } catch (err) {
    console.error(`[smoke-apfel] FAIL: ${(err as Error).message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[smoke-apfel] crashed: ${err}`);
  process.exit(1);
});
