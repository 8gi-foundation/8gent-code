// Computer control wrapper for 8gent agents.
// Prefers `usecomputer` (Zig N-API addon by remorses) when installed,
// falls back to native macOS osascript/screencapture if unavailable.

import { execSync, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ---------------------------------------------------------------------------
// Backend detection
// ---------------------------------------------------------------------------

type Backend = 'usecomputer' | 'native'

let _backend: Backend | null = null
let _ucLib: typeof import('usecomputer') | null = null

async function resolveBackend(): Promise<Backend> {
  if (_backend) return _backend

  try {
    _ucLib = await import('usecomputer')
    _backend = 'usecomputer'
    return _backend
  } catch {
    // usecomputer not installed - fall through to native
  }

  _backend = 'native'
  return _backend
}

export async function getBackend(): Promise<Backend> {
  return resolveBackend()
}

// ---------------------------------------------------------------------------
// Native fallback helpers (macOS only)
// ---------------------------------------------------------------------------

function osascript(script: string): string {
  return execFileSync('osascript', ['-e', script], {
    encoding: 'utf-8',
    timeout: 5_000,
  }).trim()
}

function nativeClick(x: number, y: number): void {
  // CGEvent via osascript - works without extra deps on macOS
  const script = [
    'use framework "CoreGraphics"',
    `set p to current application's CGPointMake(${x}, ${y})`,
    'set e1 to current application\'s CGEventCreateMouseEvent(missing value, current application\'s kCGEventLeftMouseDown, p, 0)',
    'set e2 to current application\'s CGEventCreateMouseEvent(missing value, current application\'s kCGEventLeftMouseUp, p, 0)',
    'current application\'s CGEventPost(current application\'s kCGHIDEventTap, e1)',
    'delay 0.05',
    'current application\'s CGEventPost(current application\'s kCGHIDEventTap, e2)',
  ].join('\n')
  osascript(script)
}

function nativeType(text: string): void {
  // Keystroke via System Events
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  osascript(`tell application "System Events" to keystroke "${escaped}"`)
}

function nativePressKey(key: string): void {
  // Supports modifier+key like "cmd+s" or plain keys
  const parts = key.toLowerCase().split('+')
  const mainKey = parts.pop()!
  const modifiers = parts
    .map((m) => {
      const map: Record<string, string> = {
        cmd: 'command down',
        command: 'command down',
        ctrl: 'control down',
        control: 'control down',
        alt: 'option down',
        option: 'option down',
        shift: 'shift down',
      }
      return map[m]
    })
    .filter(Boolean)

  const using = modifiers.length ? ` using {${modifiers.join(', ')}}` : ''
  osascript(
    `tell application "System Events" to keystroke "${mainKey}"${using}`,
  )
}

function nativeScreenshot(outPath?: string): string {
  const dir = join(tmpdir(), '8gent-screenshots')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const dest = outPath ?? join(dir, `screenshot-${Date.now()}.png`)
  execFileSync('screencapture', ['-x', dest], { timeout: 10_000 })
  return dest
}

function nativeScroll(
  direction: 'up' | 'down',
  amount: number,
): void {
  const delta = direction === 'up' ? amount : -amount
  const script = [
    'use framework "CoreGraphics"',
    `set e to current application's CGEventCreateScrollWheelEvent(missing value, 0, 1, ${delta})`,
    'current application\'s CGEventPost(current application\'s kCGHIDEventTap, e)',
  ].join('\n')
  osascript(script)
}

// ---------------------------------------------------------------------------
// Unified public API
// ---------------------------------------------------------------------------

export async function click(
  x: number,
  y: number,
  options?: { button?: 'left' | 'right' | 'middle'; count?: number },
): Promise<void> {
  const backend = await resolveBackend()
  if (backend === 'usecomputer' && _ucLib) {
    await _ucLib.click({
      point: { x, y },
      button: options?.button ?? 'left',
      count: options?.count ?? 1,
    })
  } else {
    nativeClick(x, y)
  }
}

export async function type(text: string): Promise<void> {
  const backend = await resolveBackend()
  if (backend === 'usecomputer' && _ucLib) {
    await _ucLib.typeText({ text })
  } else {
    nativeType(text)
  }
}

export async function pressKey(key: string): Promise<void> {
  const backend = await resolveBackend()
  if (backend === 'usecomputer' && _ucLib) {
    await _ucLib.press({ key, count: 1 })
  } else {
    nativePressKey(key)
  }
}

export async function screenshot(path?: string): Promise<string> {
  const backend = await resolveBackend()
  if (backend === 'usecomputer' && _ucLib) {
    const result = await _ucLib.screenshot({
      path: path ?? null,
      display: null,
      window: null,
      region: null,
      annotate: null,
    })
    return result.path
  }
  return nativeScreenshot(path)
}

export async function scroll(
  direction: 'up' | 'down',
  amount = 3,
): Promise<void> {
  const backend = await resolveBackend()
  if (backend === 'usecomputer' && _ucLib) {
    await _ucLib.scroll({ direction, amount })
  } else {
    nativeScroll(direction, amount)
  }
}

export async function hover(x: number, y: number): Promise<void> {
  const backend = await resolveBackend()
  if (backend === 'usecomputer' && _ucLib) {
    await _ucLib.hover({ x, y })
  } else {
    // Native hover via CGEvent mouse move
    const script = [
      'use framework "CoreGraphics"',
      `set p to current application's CGPointMake(${x}, ${y})`,
      'set e to current application\'s CGEventCreateMouseEvent(missing value, current application\'s kCGEventMouseMoved, p, 0)',
      'current application\'s CGEventPost(current application\'s kCGHIDEventTap, e)',
    ].join('\n')
    osascript(script)
  }
}
