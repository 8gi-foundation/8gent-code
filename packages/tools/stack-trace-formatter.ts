/**
 * stack-trace-formatter
 *
 * Formats error stack traces with ANSI syntax highlighting, source context
 * lines, relative path display, and node_modules filtering.
 *
 * Usage:
 *   import { formatStack, formatError } from './stack-trace-formatter'
 *   console.log(formatError(new Error('oops')))
 */

import { readFileSync } from 'fs'
import { relative, sep } from 'path'

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------
const RESET  = '\x1b[0m'
const BOLD   = '\x1b[1m'
const DIM    = '\x1b[2m'
const RED    = '\x1b[31m'
const YELLOW = '\x1b[33m'
const CYAN   = '\x1b[36m'
const GREEN  = '\x1b[32m'
const WHITE  = '\x1b[97m'

const c = {
  reset:     (s: string) => `${RESET}${s}${RESET}`,
  bold:      (s: string) => `${BOLD}${s}${RESET}`,
  dim:       (s: string) => `${DIM}${s}${RESET}`,
  red:       (s: string) => `${RED}${s}${RESET}`,
  yellow:    (s: string) => `${YELLOW}${s}${RESET}`,
  cyan:      (s: string) => `${CYAN}${s}${RESET}`,
  green:     (s: string) => `${GREEN}${s}${RESET}`,
  white:     (s: string) => `${WHITE}${s}${RESET}`,
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface FormatOptions {
  /** Lines of source code to show around the error line. Default: 2 */
  contextLines?: number
  /** Strip node_modules frames from output. Default: true */
  filterNodeModules?: boolean
  /** Working directory for relative path display. Default: process.cwd() */
  cwd?: string
  /** Max number of stack frames to display. Default: 10 */
  maxFrames?: number
}

interface ParsedFrame {
  raw: string
  fn: string | null
  file: string | null
  line: number | null
  col: number | null
  isNodeModules: boolean
  isNode: boolean   // built-in node: or node_modules
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------
const FRAME_RE = /^\s+at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/

function parseFrame(line: string, cwd: string): ParsedFrame {
  const m = FRAME_RE.exec(line)
  if (!m) {
    return { raw: line, fn: null, file: null, line: null, col: null, isNodeModules: false, isNode: false }
  }
  const [, fn, file, lineStr, colStr] = m
  const lineNo  = parseInt(lineStr, 10)
  const colNo   = parseInt(colStr, 10)
  const isNodeModules = file.includes(`${sep}node_modules${sep}`) || file.includes('/node_modules/')
  const isNode  = file.startsWith('node:') || file.startsWith('internal/')
  const relFile = file.startsWith('/') ? relative(cwd, file) : file
  return { raw: line, fn: fn?.trim() ?? null, file: relFile, line: lineNo, col: colNo, isNodeModules, isNode }
}

// ---------------------------------------------------------------------------
// Source context reader
// ---------------------------------------------------------------------------
function readContext(file: string, line: number, contextLines: number, cwd: string): string[] | null {
  const abs = file.startsWith('/') ? file : `${cwd}/${file}`
  try {
    const src  = readFileSync(abs, 'utf8').split('\n')
    const from = Math.max(0, line - 1 - contextLines)
    const to   = Math.min(src.length - 1, line - 1 + contextLines)
    const out: string[] = []
    for (let i = from; i <= to; i++) {
      const lineNo  = String(i + 1).padStart(4)
      const isErr   = i === line - 1
      const prefix  = isErr ? c.red('>') : ' '
      const num     = isErr ? c.red(c.bold(lineNo)) : c.dim(lineNo)
      const code    = isErr ? c.white(src[i]) : c.dim(src[i])
      out.push(`  ${prefix} ${num} | ${code}`)
    }
    return out
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Frame renderer
// ---------------------------------------------------------------------------
function renderFrame(f: ParsedFrame, isFirst: boolean, contextLines: number, cwd: string): string {
  if (f.file === null) return c.dim(f.raw)

  const fn       = f.fn ? c.cyan(f.fn) : c.dim('<anonymous>')
  const filePart = f.isNodeModules || f.isNode
    ? c.dim(f.file)
    : c.yellow(f.file)
  const linePart = f.line != null ? c.dim(`:${f.line}:${f.col}`) : ''
  const label    = `  ${c.dim('at')} ${fn} ${c.dim('(')}${filePart}${linePart}${c.dim(')')}`

  const lines: string[] = [label]

  if (isFirst && !f.isNodeModules && !f.isNode && f.line != null && contextLines > 0) {
    const ctx = readContext(f.file, f.line, contextLines, cwd)
    if (ctx) lines.push('', ...ctx, '')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Format a raw stack trace string with ANSI highlighting.
 */
export function formatStack(stack: string, options: FormatOptions = {}): string {
  const {
    contextLines     = 2,
    filterNodeModules = true,
    cwd              = process.cwd(),
    maxFrames        = 10,
  } = options

  const lines  = stack.split('\n')
  const header = lines[0] // "ErrorType: message"
  const frames = lines.slice(1)

  const parsed = frames
    .map(l => parseFrame(l, cwd))
    .filter(f => !filterNodeModules || (!f.isNodeModules && !f.isNode) || f.file === null)
    .slice(0, maxFrames)

  const formattedHeader = header.replace(/^(\w*Error)(.*)/, (_, type, rest) =>
    `${c.bold(c.red(type))}${c.white(rest)}`
  )

  const formattedFrames = parsed.map((f, i) =>
    renderFrame(f, i === 0, contextLines, cwd)
  )

  const nodeModulesCount = frames.length - parsed.length
  const footer = nodeModulesCount > 0
    ? c.dim(`\n  ... ${nodeModulesCount} node_modules frame(s) hidden`)
    : ''

  return [formattedHeader, ...formattedFrames, footer].filter(Boolean).join('\n')
}

/**
 * Format an Error object with ANSI-highlighted stack trace.
 */
export function formatError(error: Error | unknown, options: FormatOptions = {}): string {
  if (!(error instanceof Error)) {
    return c.bold(c.red(String(error)))
  }
  const stack = error.stack ?? `${error.name}: ${error.message}`
  return formatStack(stack, options)
}
