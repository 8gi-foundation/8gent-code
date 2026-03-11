#!/usr/bin/env bun
/**
 * 8gent Code - Quarantine CLI
 *
 * Command-line interface for managing skill quarantine.
 *
 * Usage:
 *   8gent quarantine <command> [args]
 *
 * Commands:
 *   add <source>     Quarantine an external skill
 *   scan <id>        Run security scan on quarantined skill
 *   list [status]    List quarantined skills
 *   release <id>     Release approved skill to toolshed
 *   reject <id>      Reject and archive skill
 *   cleanup          Remove old rejected skills
 */

import { getQuarantineManager } from "./index.js";
import { formatScanResult } from "./scanner/security-scanner.js";
import { getSkillRegistry } from "../toolshed/skill-registry.js";

const HELP = `
🔒 8gent Quarantine - Skill Security System

Usage: 8gent quarantine <command> [args]

Commands:
  add <source>        Quarantine an external skill for review
                      Sources: GitHub URL, npm package, local path

  scan <id>           Run security scan on quarantined skill
                      Returns: PASS, FAIL, or REVIEW_REQUIRED

  list [status]       List quarantined skills
                      Statuses: pending, scanned, approved, rejected

  release <id>        Release approved skill to toolshed
                      Requires: Scan must have passed

  reject <id> [reason]  Reject skill (kept for forensics)

  cleanup [days]      Remove rejected skills older than N days (default: 30)

  stats               Show quarantine statistics

Examples:
  8gent quarantine add https://github.com/user/skill
  8gent quarantine scan skill-1234567890-abc123
  8gent quarantine list pending
  8gent quarantine release skill-1234567890-abc123
  8gent quarantine reject skill-1234567890-abc123 "Suspicious network calls"
`;

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
    console.log(HELP);
    process.exit(0);
  }

  const command = args[0];
  const quarantine = getQuarantineManager();

  try {
    switch (command) {
      case "add": {
        const source = args[1];
        if (!source) {
          console.error("Error: Source required. Usage: quarantine add <source>");
          process.exit(1);
        }

        console.log(`\n📥 Quarantining: ${source}\n`);
        const entry = await quarantine.quarantine(source);
        console.log(`✅ Quarantined as: ${entry.id}`);
        console.log(`\nNext: 8gent quarantine scan ${entry.id}`);
        break;
      }

      case "scan": {
        const id = args[1];
        if (!id) {
          console.error("Error: ID required. Usage: quarantine scan <id>");
          process.exit(1);
        }

        const result = await quarantine.scan(id);
        console.log(formatScanResult(result));

        const entry = quarantine.get(id);
        if (entry?.status === "rejected") {
          console.log("\n🚫 Auto-rejected due to CRITICAL findings.");
        } else if (result.verdict === "PASS") {
          console.log(`\nNext: 8gent quarantine release ${id}`);
        } else if (result.verdict === "REVIEW_REQUIRED") {
          console.log(`\nNext: Review findings, then:`);
          console.log(`  8gent quarantine release ${id}  (to approve)`);
          console.log(`  8gent quarantine reject ${id}   (to reject)`);
        }
        break;
      }

      case "list": {
        const status = args[1] as any;
        const entries = quarantine.list(status);

        if (entries.length === 0) {
          console.log("\n📭 No skills in quarantine" + (status ? ` with status: ${status}` : ""));
          process.exit(0);
        }

        console.log(`\n🔒 Quarantined Skills${status ? ` (${status})` : ""}\n`);
        console.log("─".repeat(60));

        for (const entry of entries) {
          const statusEmoji = {
            pending: "⏳",
            scanned: "🔍",
            abstracted: "🔧",
            approved: "✅",
            rejected: "🚫",
          }[entry.status];

          console.log(`${statusEmoji} ${entry.id}`);
          console.log(`   Name: ${entry.name}`);
          console.log(`   Source: ${entry.source}`);
          console.log(`   Status: ${entry.status}`);
          console.log(`   Quarantined: ${entry.quarantinedAt.toISOString()}`);

          if (entry.scanResult) {
            console.log(`   Scan Verdict: ${entry.scanResult.verdict}`);
          }
          if (entry.rejectionReason) {
            console.log(`   Rejection: ${entry.rejectionReason}`);
          }
          console.log("");
        }
        break;
      }

      case "release": {
        const id = args[1];
        if (!id) {
          console.error("Error: ID required. Usage: quarantine release <id>");
          process.exit(1);
        }

        const entry = quarantine.get(id);
        if (!entry) {
          console.error(`Error: Entry not found: ${id}`);
          process.exit(1);
        }

        // Abstract if not already done
        if (entry.status === "scanned") {
          console.log("\n🔧 Abstracting skill to 8gent format...");
          const abstracted = await quarantine.abstract(id);
          console.log(`   Name: ${abstracted.name}`);
          console.log(`   Capabilities: ${abstracted.capabilities.join(", ") || "none detected"}`);
          console.log(`   Token estimate: ${abstracted.tokenEstimate}`);
        }

        // Release
        console.log("\n📤 Releasing to toolshed...");
        await quarantine.release(id);

        // Register with skill registry
        const updatedEntry = quarantine.get(id);
        if (updatedEntry?.abstractedSkill) {
          const registry = getSkillRegistry();
          registry.register(updatedEntry.abstractedSkill);
        }

        console.log(`\n✅ Skill released! Now available in 8gent.`);
        break;
      }

      case "reject": {
        const id = args[1];
        const reason = args.slice(2).join(" ") || "Manually rejected";

        if (!id) {
          console.error("Error: ID required. Usage: quarantine reject <id> [reason]");
          process.exit(1);
        }

        await quarantine.reject(id, reason);
        console.log(`\n🚫 Rejected: ${id}`);
        console.log(`   Reason: ${reason}`);
        break;
      }

      case "cleanup": {
        const days = parseInt(args[1]) || 30;
        console.log(`\n🧹 Cleaning up rejected skills older than ${days} days...`);
        const removed = quarantine.cleanup(days);
        console.log(`   Removed: ${removed} entries`);
        break;
      }

      case "stats": {
        const entries = quarantine.list();
        const byStat = {
          pending: entries.filter(e => e.status === "pending").length,
          scanned: entries.filter(e => e.status === "scanned").length,
          abstracted: entries.filter(e => e.status === "abstracted").length,
          approved: entries.filter(e => e.status === "approved").length,
          rejected: entries.filter(e => e.status === "rejected").length,
        };

        console.log("\n📊 Quarantine Statistics\n");
        console.log("─".repeat(30));
        console.log(`⏳ Pending:    ${byStat.pending}`);
        console.log(`🔍 Scanned:    ${byStat.scanned}`);
        console.log(`🔧 Abstracted: ${byStat.abstracted}`);
        console.log(`✅ Approved:   ${byStat.approved}`);
        console.log(`🚫 Rejected:   ${byStat.rejected}`);
        console.log("─".repeat(30));
        console.log(`   Total:      ${entries.length}`);
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        console.log(HELP);
        process.exit(1);
    }
  } catch (err) {
    console.error(`\n❌ Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

main();
