import * as fs from 'fs';
import * as path from 'path';

interface WalkOptions {
  include?: string[];
  exclude?: string[];
  maxDepth?: number;
  followSymlinks?: boolean;
  onError?: (err: Error) => void;
}

function matchesPattern(file: string, pattern: string): boolean {
  const escapedPattern = pattern.replace(/([.*+?^${}()|[\]\\])/g, '\\$1');
  const regex = escapedPattern.replace(/\*/g, '.*').replace(/\\/g, '\\\\');
  return new RegExp('^' + regex + '$').test(file);
}

/**
 * Recursively walk the file system starting at `dir`, yielding absolute paths.
 * @param dir The directory to start walking from.
 * @param options Options for filtering and limiting the walk.
 */
export async function* walk(dir: string, options: WalkOptions = {}): AsyncIterable<string> {
  const { include = [], exclude = [], maxDepth = Infinity, followSymlinks = true, onError } = options;
  const absoluteDir = path.resolve(dir);
  let depth = 0;

  try {
    const entries = await fs.promises.readdir(absoluteDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(absoluteDir, entry.name);
      const isDirectory = entry.isDirectory();
      const isSymlink = entry.isSymbolicLink();

      if (exclude.some(pattern => matchesPattern(fullPath, pattern))) {
        continue;
      }

      if (include.length > 0 && !include.some(pattern => matchesPattern(fullPath, pattern))) {
        continue;
      }

      if (isDirectory && depth < maxDepth) {
        if (followSymlinks || !isSymlink) {
          yield* walk(fullPath, { ...options, maxDepth: depth + 1 });
        }
      } else if (!isDirectory) {
        yield fullPath;
      }
    }
  } catch (err) {
    if (onError) {
      onError(err as Error);
    }
  }
}

/**
 * Synchronous version of `walk`.
 * @param dir The directory to start walking from.
 * @param options Options for filtering and limiting the walk.
 * @returns An array of absolute paths.
 */
export function walkSync(dir: string, options: WalkOptions = {}): string[] {
  const { include = [], exclude = [], maxDepth = Infinity, followSymlinks = true, onError } = options;
  const result: string[] = [];
  const absoluteDir = path.resolve(dir);
  let depth = 0;

  try {
    const entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(absoluteDir, entry.name);
      const isDirectory = entry.isDirectory();
      const isSymlink = entry.isSymbolicLink();

      if (exclude.some(pattern => matchesPattern(fullPath, pattern))) {
        continue;
      }

      if (include.length > 0 && !include.some(pattern => matchesPattern(fullPath, pattern))) {
        continue;
      }

      if (isDirectory && depth < maxDepth) {
        if (followSymlinks || !isSymlink) {
          result.push(...walkSync(fullPath, { ...options, maxDepth: depth + 1 }));
        }
      } else if (!isDirectory) {
        result.push(fullPath);
      }
    }
  } catch (err) {
    if (onError) {
      onError(err as Error);
    }
  }

  return result;
}