#!/usr/bin/env bun
/**
 * @8gent/telegram-bot — Nightly Intelligence Cron
 *
 * Run nightly at 3 AM via: bun run packages/telegram-bot/install-cron.ts
 *
 * Scrapes GitHub trending, scores relevance, updates knowledge base,
 * and sends a formatted digest to the 8gent Telegram chat.
 */

import { GitHubIntelligence } from "./intelligence";
import { TelegramBot } from "./index";

async function main(): Promise<void> {
  const startTime = Date.now();
  console.log(`[cron-intel] Starting nightly intelligence run at ${new Date().toISOString()}`);

  const intel = new GitHubIntelligence();
  const bot = new TelegramBot();

  try {
    const digest = await intel.runNightlyIntelligence();

    // Send the digest to Telegram
    await bot.sendMessage(digest, { parseMode: "Markdown" });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[cron-intel] Completed in ${elapsed}s`);
  } catch (err: any) {
    const errorMsg = `*Intelligence Cron Error*\n\n\`${err.message}\`\n\n_${new Date().toISOString()}_`;
    console.error(`[cron-intel] Error: ${err.message}`);

    // Try to notify via Telegram even on failure
    try {
      await bot.sendMessage(errorMsg, { parseMode: "Markdown" });
    } catch {
      console.error("[cron-intel] Failed to send error notification");
    }

    process.exit(1);
  }
}

main();
