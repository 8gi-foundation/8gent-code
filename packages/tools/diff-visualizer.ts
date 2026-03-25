/**
 * diff-visualizer.ts - Renders git diffs with colored terminal output
 *
 * Takes unified diff text and produces ANSI-colored output with:
 * - File headers (bold cyan)
 * - Hunk headers (dim)
 * - Additions (green with + prefix)
 * - Deletions (red with - prefix)
 * - Context lines (default color)
 *
 * Usage:
 *   import { visualizeDiff, visualizeDiffFromStaged } from './diff-visualizer'
 *   const colored = visualizeDiff(rawDiffString)
 *   console.log(colored)
 */

// ANSI escape helpers - no deps needed
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const CYAN = '\x1b[36m'
const BG_RED = '\x1b[41m'
const BG_GREEN = '\x1b[42m'

export interface DiffVisualizerOptions {
  /** Show line numbers in the gutter (default: true) */
  lineNumbers?: boolean
  /** Highlight trailing whitespace in additions (default: true) */
  highlightWhitespace?: boolean
  /** Max context lines to show per hunk - pass-through, does not truncate (default: Infinity) */
  maxContext?: number
}

interface HunkLine {
  type: 'add' | 'del' | 'context' | 'hunk-header'
  content: string
  oldLine?: number
  newLine?: number
}

function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
  if (!match) return null
  return { oldStart: parseInt(match[1], 10), newStart: parseInt(match[2], 10) }
}

function classifyLine(line: string): HunkLine['type'] {
  if (line.startsWith('@@')) return 'hunk-header'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}

function formatGutter(oldLine: number | undefined, newLine: number | undefined): string {
  const old = oldLine !== undefined ? String(oldLine).padStart(4) : '    '
  const neu = newLine !== undefined ? String(newLine).padStart(4) : '    '
  return `${DIM}${old} ${neu}${RESET} `
}

function highlightTrailingWs(text: string): string {
  const trailing = text.match(/(\s+)$/)
  if (!trailing) return text
  const ws = trailing[1]
  return text.slice(0, -ws.length) + `${BG_RED}${ws}${RESET}`
}

/**
 * Render a unified diff string into ANSI-colored terminal output.
 */
export function visualizeDiff(
  diff: string,
  options: DiffVisualizerOptions = {}
): string {
  const { lineNumbers = true, highlightWhitespace = true } = options

  if (!diff.trim()) return `${DIM}(no changes)${RESET}`

  const lines = diff.split('\n')
  const output: string[] = []
  let oldLine = 0
  let newLine = 0

  for (const line of lines) {
    // File header lines
    if (line.startsWith('diff --git')) {
      const filePath = line.replace(/^diff --git a\/.+ b\//, '')
      output.push('')
      output.push(`${BOLD}${CYAN}--- ${filePath} ---${RESET}`)
      continue
    }

    // Skip index and --- +++ meta lines
    if (line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      continue
    }

    // Hunk header
    const hunk = parseHunkHeader(line)
    if (hunk) {
      oldLine = hunk.oldStart
      newLine = hunk.newStart
      const rest = line.replace(/^@@ .+? @@/, '').trim()
      const label = rest ? ` ${rest}` : ''
      output.push(`${DIM}@@ line ${hunk.oldStart} -> ${hunk.newStart}${label} @@${RESET}`)
      continue
    }

    const type = classifyLine(line)
    const content = line.slice(1) // strip the +/- / space prefix
    const gutter = lineNumbers
      ? formatGutter(
          type === 'add' ? undefined : oldLine,
          type === 'del' ? undefined : newLine
        )
      : ''

    if (type === 'add') {
      const display = highlightWhitespace ? highlightTrailingWs(content) : content
      output.push(`${gutter}${GREEN}+${display}${RESET}`)
      newLine++
    } else if (type === 'del') {
      output.push(`${gutter}${RED}-${content}${RESET}`)
      oldLine++
    } else {
      output.push(`${gutter} ${content}`)
      oldLine++
      newLine++
    }
  }

  return output.join('\n')
}

/**
 * Run `git diff` (or `git diff --staged`) and visualize the result.
 * Requires Bun or a runtime with subprocess support.
 */
export async function visualizeDiffFromGit(
  cwd: string,
  staged = false
): Promise<string> {
  const args = ['git', 'diff']
  if (staged) args.push('--staged')

  const proc = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const text = await new Response(proc.stdout).text()
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(`git diff failed (exit ${exitCode}): ${err}`)
  }

  return visualizeDiff(text)
}
