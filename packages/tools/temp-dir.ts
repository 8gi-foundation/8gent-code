import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

/**
 * Creates a temporary directory with optional prefix.
 * @param prefix - Optional prefix for the directory name.
 * @returns Object with path to the directory and cleanup function.
 */
function createTempDir(prefix?: string): { path: string; cleanup: () => void } {
  const dirName = prefix ? `${prefix}-${crypto.randomBytes(16).toString('hex')}` : `tmp-${crypto.randomBytes(16).toString('hex')}`
  const tempDir = path.join(os.tmpdir(), dirName)
  fs.mkdirSync(tempDir, { recursive: true })
  return {
    path: tempDir,
    cleanup: () => {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  }
}

/**
 * Executes a function with a temporary directory, then cleans it up.
 * @param fn - Function to execute, receives the temporary directory path.
 */
function withTempDir(fn: (path: string) => void): void {
  const { path, cleanup } = createTempDir()
  try {
    fn(path)
  } finally {
    cleanup()
  }
}

export { createTempDir, withTempDir }