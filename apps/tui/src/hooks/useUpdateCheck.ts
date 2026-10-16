import { useEffect, useState } from "react";
import { isUpdateCheckEnabled } from "../../../../packages/eight/update-notice.js";

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

export { isUpdateCheckEnabled };

export async function checkForUpdate(
	env: Record<string, string | undefined>,
	current: string,
	fetchFn: typeof fetch = fetch,
): Promise<UpdateInfo | null> {
	if (!isUpdateCheckEnabled(env)) return null;
	try {
		const res = await fetchFn(
			"https://raw.githubusercontent.com/8gi-foundation/8gent-code/main/package.json",
			{ signal: AbortSignal.timeout(5000) },
		);
		if (!res.ok) return null;
		const latest = (await res.json()).version;
		return latest && isNewer(current, latest) ? { available: true, latest, current } : null;
	} catch {
		return null;
	}
}

/**
 * Check GitHub for the latest version on launch, only when opted in.
 * Non-blocking, silent on failure.
 */
export function useUpdateCheck(): UpdateInfo | null {
	const [update, setUpdate] = useState<UpdateInfo | null>(null);

	useEffect(() => {
		if (!isUpdateCheckEnabled()) return;
		checkForUpdate(process.env, getCurrentVersion()).then((info) => {
			if (info) setUpdate(info);
		});
	}, []);

	return update;
}
