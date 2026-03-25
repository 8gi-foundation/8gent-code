import { useState, useEffect } from "react";

interface UpdateInfo {
  available: boolean;
  latest: string;
  current: string;
}

// Read current version from package.json at runtime
function getCurrentVersion(): string {
  try {
    const pkg = require("../../../../package.json");
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Compare semver strings. Returns true if b > a.
 */
function isNewer(current: string, latest: string): boolean {
  const a = current.split(".").map(Number);
  const b = latest.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((b[i] || 0) > (a[i] || 0)) return true;
    if ((b[i] || 0) < (a[i] || 0)) return false;
  }
  return false;
}

/**
 * Check GitHub for the latest version on launch.
 * Non-blocking, silent on failure.
 */
export function useUpdateCheck(): UpdateInfo | null {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    const check = async () => {
      try {
        // Check GitHub API for latest package.json on main
        const res = await fetch(
          "https://raw.githubusercontent.com/zerwiz/8gent-code/main/package.json",
          { signal: AbortSignal.timeout(5000) }
        );
        if (!res.ok) return;

        const pkg = await res.json();
        const latest = pkg.version;
        const current = getCurrentVersion();

        if (latest && isNewer(current, latest)) {
          setUpdate({ available: true, latest, current });
        }
      } catch {
        // Silent fail — don't block startup for update checks
      }
    };

    check();
  }, []);

  return update;
}
