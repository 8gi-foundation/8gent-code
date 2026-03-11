/**
 * 8gent Code - Voice Hook
 *
 * TTS voice output on task completion.
 * Speaks the completion summary using macOS `say` command.
 *
 * Features:
 * - Extracts 🎯 COMPLETED: text from agent output
 * - Speaks via macOS Ava voice
 * - Fallback message if no completion marker found
 * - Configurable voice and rate
 */

import { spawn } from "child_process";
import { platform } from "os";

// ============================================
// Types
// ============================================

export interface VoiceConfig {
  enabled: boolean;
  voice: string;
  rate: number; // Words per minute
  maxLength: number; // Max chars to speak
  fallbackMessage: string;
}

const DEFAULT_CONFIG: VoiceConfig = {
  enabled: true,
  voice: "Ava", // macOS voice
  rate: 200,
  maxLength: 350,
  fallbackMessage: "Task complete. The Infinite Gentleman has delivered.",
};

// ============================================
// Voice Hook Manager
// ============================================

let voiceConfig: VoiceConfig = { ...DEFAULT_CONFIG };

export function configureVoice(config: Partial<VoiceConfig>): void {
  voiceConfig = { ...voiceConfig, ...config };
}

export function getVoiceConfig(): VoiceConfig {
  return { ...voiceConfig };
}

// ============================================
// Main Functions
// ============================================

/**
 * Extract completion message from agent output
 */
export function extractCompletionMessage(output: string): string | null {
  // Look for 🎯 COMPLETED: marker
  const completedMatch = output.match(/🎯\s*COMPLETED:\s*(.+?)(?:\n|$)/i);
  if (completedMatch) {
    return completedMatch[1].trim().slice(0, voiceConfig.maxLength);
  }

  // Alternative markers
  const doneMatch = output.match(/✅\s*DONE:\s*(.+?)(?:\n|$)/i);
  if (doneMatch) {
    return doneMatch[1].trim().slice(0, voiceConfig.maxLength);
  }

  const summaryMatch = output.match(/SUMMARY:\s*(.+?)(?:\n|$)/i);
  if (summaryMatch) {
    return summaryMatch[1].trim().slice(0, voiceConfig.maxLength);
  }

  return null;
}

/**
 * Speak text using macOS `say` command
 */
export async function speak(text: string): Promise<void> {
  if (!voiceConfig.enabled) return;

  // Only works on macOS
  if (platform() !== "darwin") {
    console.log(`[Voice] ${text}`);
    return;
  }

  return new Promise((resolve, reject) => {
    const args = [
      "-v", voiceConfig.voice,
      "-r", voiceConfig.rate.toString(),
      text,
    ];

    const proc = spawn("say", args, {
      stdio: ["ignore", "ignore", "ignore"],
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`say command exited with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Hook handler for onComplete events
 */
export async function voiceCompletionHook(context: {
  result?: string;
  output?: string;
  response?: string;
}): Promise<void> {
  const output = context.result || context.output || context.response || "";

  // Extract completion message
  let message = extractCompletionMessage(output);

  // Use fallback if no marker found
  if (!message) {
    message = voiceConfig.fallbackMessage;
  }

  // Speak the message
  try {
    await speak(message);
  } catch (err) {
    // Silent failure - voice is optional
    console.error("[Voice] Failed to speak:", err);
  }
}

/**
 * Generate completion message with 8gent personality
 */
export function generateCompletionVoice(
  summary: string,
  branch?: string | null,
  status?: "committed" | "pushed" | "pr_created" | null,
  tested?: boolean
): string {
  const openers = [
    "Ah, splendid.",
    "Another task dispatched.",
    "The Infinite Gentleman delivers.",
    "Consider it done.",
    "Excellence achieved.",
    "Naturally, it's complete.",
    "As requested, good sir.",
    "The deed is done.",
    "Quite satisfactory.",
    "Perfection, as always.",
  ];

  const closers = [
    "At your service.",
    "What's next?",
    "The pleasure was mine.",
    "Anything else?",
    "Onwards.",
    "Until next time.",
  ];

  const opener = openers[Math.floor(Math.random() * openers.length)];
  const closer = closers[Math.floor(Math.random() * closers.length)];

  let message = `${opener} ${summary}`;

  if (branch) {
    message += ` on ${branch}`;
  }

  if (status === "committed") {
    message += ". Committed.";
  } else if (status === "pushed") {
    message += ". Pushed.";
  } else if (status === "pr_created") {
    message += ". PR created.";
  }

  if (tested) {
    message += " Tested and verified.";
  }

  message += ` ${closer}`;

  return message;
}

// ============================================
// Integration with Hook System
// ============================================

import { registerHook, type Hook } from "./index.js";

/**
 * Register the voice completion hook
 */
export function setupVoiceHook(): Hook {
  return registerHook({
    type: "onComplete",
    name: "Voice Completion",
    description: "Speaks task completion summary using TTS",
    mode: "function",
    functionBody: `
      const message = extractCompletionMessage(context.result || context.output || "");
      if (message) {
        await speak(message);
      }
    `,
    enabled: true,
    async: true,
    continueOnError: true,
  });
}

/**
 * Test voice output
 */
export async function testVoice(): Promise<void> {
  await speak("The Infinite Gentleman is ready to serve.");
}

// ============================================
// Exports
// ============================================

export default {
  configureVoice,
  getVoiceConfig,
  extractCompletionMessage,
  speak,
  voiceCompletionHook,
  generateCompletionVoice,
  setupVoiceHook,
  testVoice,
};
