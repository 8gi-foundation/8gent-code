/**
 * conditional-import.ts
 *
 * Safely imports modules that may not be installed.
 * All functions are side-effect-free and composable.
 */

const _cache = new Map<string, boolean>();

export async function tryImport<T>(specifier: string): Promise<T | null> {
  try {
    const mod = await import(specifier);
    _cache.set(specifier, true);
    return (mod?.default ?? mod) as T;
  } catch {
    _cache.set(specifier, false);
    return null;
  }
}

export async function requireOptional<T>(specifier: string, fallback: T): Promise<T> {
  const mod = await tryImport<T>(specifier);
  return mod ?? fallback;
}

export async function isAvailable(specifier: string): Promise<boolean> {
  const cached = _cache.get(specifier);
  if (cached !== undefined) return cached;
  try {
    await import(specifier);
    _cache.set(specifier, true);
    return true;
  } catch {
    _cache.set(specifier, false);
    return false;
  }
}

export async function importWithTimeout<T>(specifier: string, ms: number = 5000): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Import of "${specifier}" timed out after ${ms}ms`)), ms);
  });
  try {
    const mod = await Promise.race([import(specifier), timeout]);
    _cache.set(specifier, true);
    return (mod?.default ?? mod) as T;
  } catch {
    _cache.set(specifier, false);
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function clearImportCache(): void {
  _cache.clear();
}
