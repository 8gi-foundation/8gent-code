/**
 * Shared data directory resolution for the Eight daemon.
 *
 * Priority:
 *   1. EIGHT_DATA_DIR env var (for cloud / Fly.io deployments)
 *   2. ~/.8gent/ (default local path)
 *
 * On Fly.io the volume is mounted at /root/.8gent/ and HOME=/root,
 * so both paths resolve to the same location by default. Setting
 * EIGHT_DATA_DIR explicitly makes the intent clear and decouples
 * from HOME.
 */

import * as os from "os";
import * as path from "path";
import * as fs from "fs";

/**
 * Returns the root data directory for 8gent persistent storage.
 * Creates the directory if it doesn't exist.
 */
export function getDataDir(): string {
  const dir = process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Returns a subdirectory under the data dir.
 * Creates it if it doesn't exist.
 */
export function getDataSubDir(...segments: string[]): string {
  const dir = path.join(getDataDir(), ...segments);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}
