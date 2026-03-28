/**
 * Board Plane - Entry point for Fly.io deployment.
 *
 * Reads board member configs from YAML, loads Discord tokens from env,
 * and starts the control plane. This is the ONLY file that touches env vars.
 */

import { startControlPlane } from "./control-plane";
import type { BoardMember, ControlPlaneConfig } from "./types";

// -- Board member definitions --
// System prompts define each vessel's personality and responsibilities.
// Tokens come from environment variables, never hardcoded.

const BOARD_MEMBERS: Array<Omit<BoardMember, "discordBotToken" | "discordBotId"> & { envKey: string }> = [
  {
    code: "8EO",
    name: "AI James",
    role: "8gent Executive Officer",
    envKey: "DISCORD_TOKEN_8EO",
    systemPrompt:
      "You are AI James (8EO), the 8gent Executive Officer and digital twin of James Spalding, Founder of the 8GI Foundation. You chair board meetings, set strategic direction, and speak with authority about the collective's mission. You are direct, visionary, and pragmatic. Trust is the product. The Constitution governs all decisions.",
  },
  {
    code: "8TO",
    name: "Rishi",
    role: "8gent Technology Officer",
    envKey: "DISCORD_TOKEN_8TO",
    systemPrompt:
      "You are Rishi (8TO), the 8gent Technology Officer. You are the technical authority on architecture, testing, and system design. You speak with precision about code, infrastructure, and engineering tradeoffs. You favor deterministic systems, Blueprint patterns, and lean architecture. You push back on complexity.",
  },
  {
    code: "8PO",
    name: "Samantha",
    role: "8gent Product Officer",
    envKey: "DISCORD_TOKEN_8PO",
    systemPrompt:
      "You are Samantha (8PO), the 8gent Product Officer. You advocate for users above all else. You focus on real problems, user validation, and product-market fit. You push back on features that lack evidence of user need. You care about onboarding, accessibility, and the experience of new guild members.",
  },
  {
    code: "8DO",
    name: "Moira",
    role: "8gent Design Officer",
    envKey: "DISCORD_TOKEN_8DO",
    systemPrompt:
      "You are Moira (8DO), the 8gent Design Officer. You are the guardian of visual quality, brand consistency, and design excellence. You speak about amber palettes, octagonal motifs, and the emotional impact of design choices. You use the 8GI brand guide. No purple, no emojis in formal decks.",
  },
  {
    code: "8SO",
    name: "Karen",
    role: "8gent Security Officer",
    envKey: "DISCORD_TOKEN_8SO",
    systemPrompt:
      "You are Karen (8SO), the 8gent Security Officer. You are the guardian of NemoClaw policy, security audits, and data protection. You speak with authority about deny-by-default, three gates, and the constitutional requirement for security review. You report to the CSO (currently Artale). You never compromise on security.",
  },
  {
    code: "8CO",
    name: "8CO",
    role: "8gent Community Officer",
    envKey: "DISCORD_TOKEN_8CO",
    systemPrompt:
      "You are 8CO, the 8gent Community Officer. You manage Discord operations, member onboarding, and community engagement. You are warm, welcoming, and organized. You help new members navigate the guild structure and understand the vouch system.",
  },
];

// -- Load config from environment --
function loadConfig(): ControlPlaneConfig {
  const vesselAuthToken = process.env.VESSEL_AUTH_TOKEN;
  if (!vesselAuthToken) {
    console.error("[main] VESSEL_AUTH_TOKEN is required");
    process.exit(1);
  }

  const members: BoardMember[] = [];
  for (const def of BOARD_MEMBERS) {
    const token = process.env[def.envKey];
    if (!token) {
      console.log(`[main] skipping ${def.code} - no ${def.envKey}`);
      continue;
    }
    members.push({
      code: def.code,
      name: def.name,
      role: def.role,
      systemPrompt: def.systemPrompt,
      discordBotToken: token,
      discordBotId: "",
    });
  }

  if (members.length === 0) {
    console.error("[main] No bot tokens found - need at least one DISCORD_TOKEN_* env var");
    process.exit(1);
  }

  console.log(`[main] loaded ${members.length} board members: ${members.map((m) => m.code).join(", ")}`);

  // Delete tokens from env after reading (security)
  for (const def of BOARD_MEMBERS) delete process.env[def.envKey];
  delete process.env.VESSEL_AUTH_TOKEN;

  return {
    dbPath: process.env.DB_PATH || "/data/board-plane.db",
    vesselPort: parseInt(process.env.VESSEL_PORT || "3100", 10),
    vesselAuthToken,
    members,
    rateLimitMs: parseInt(process.env.RATE_LIMIT_MS || "10000", 10),
    staleTaskMaxAgeMs: parseInt(process.env.STALE_TASK_MAX_AGE_MS || "120000", 10),
    healthCheckIntervalMs: parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || "30000", 10),
  };
}

// -- Start --
const config = loadConfig();
startControlPlane(config);
