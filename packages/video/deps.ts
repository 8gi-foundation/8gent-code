/**
 * Dependency checker — verifies yt-dlp, ffmpeg, and ffprobe are available.
 * Auto-installs via brew on macOS if missing.
 */

import { execSync } from "child_process";

export interface DepsStatus {
  ready: boolean;
  missing: string[];
  platform: string;
}

const REQUIRED_BINS = ["ffmpeg", "ffprobe", "yt-dlp"];

function hasBin(name: string): boolean {
  try {
    execSync(`which ${name}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function checkDeps(): DepsStatus {
  const missing = REQUIRED_BINS.filter(b => !hasBin(b));
  return {
    ready: missing.length === 0,
    missing,
    platform: process.platform,
  };
}

export function installDeps(): { installed: string[]; failed: string[] } {
  const status = checkDeps();
  if (status.ready) return { installed: [], failed: [] };

  const installed: string[] = [];
  const failed: string[] = [];

  for (const bin of status.missing) {
    try {
      if (status.platform === "darwin") {
        execSync(`brew install ${bin}`, { stdio: "pipe", timeout: 120_000 });
      } else if (status.platform === "linux") {
        // Try common package managers
        try {
          execSync(`sudo apt-get install -y ${bin}`, { stdio: "pipe", timeout: 120_000 });
        } catch {
          try {
            execSync(`pip3 install ${bin}`, { stdio: "pipe", timeout: 60_000 });
          } catch {
            throw new Error(`Could not install ${bin} — install manually`);
          }
        }
      } else {
        throw new Error(`Auto-install not supported on ${status.platform}`);
      }
      installed.push(bin);
    } catch (err: any) {
      failed.push(`${bin}: ${err.message}`);
    }
  }

  return { installed, failed };
}
