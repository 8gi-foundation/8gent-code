# Proactive Code Review - Design Spec

## Problem

Code quality issues slip through when working fast. Eight should catch bugs, security holes, and style drift automatically after every commit - without requiring a human reviewer or paid API keys.

## Constraint

Must work fully offline with Ollama (qwen3 or similar). No paid APIs. Under 200 lines.

## Not doing

- IDE integration (LSP, VS Code extension)
- Multi-repo support
- PR comment posting (GitHub API)
- Auto-fix / auto-commit corrections

## Architecture

```
packages/proactive/code-reviewer.ts  (~150 lines)
  |
  |- gitDiff()           - shell out to git for recent diff
  |- gitDiffStats()      - file/line counts from --stat
  |- callOllama()        - send diff + structured prompt, get JSON back
  |- reviewRecentCommits() - public entry point
  |- formatForTUI()      - terminal-friendly output
  |- formatForTelegram() - markdown output for bot messages
```

## Data Flow

```
git diff HEAD~N..HEAD
      |
      v
  truncate to 8k chars (configurable)
      |
      v
  Ollama /api/chat (json mode, low temperature)
      |
      v
  Parse JSON -> ReviewFinding[]
      |
      v
  Format for TUI or Telegram
```

## Types

```typescript
type Severity = "critical" | "warning" | "info";
type FindingCategory = "bug" | "style" | "security" | "suggestion";

interface ReviewFinding {
  category: FindingCategory;
  severity: Severity;
  file: string;
  line?: number;
  message: string;
}

interface CodeReview {
  timestamp: string;
  commitRange: string;
  filesChanged: number;
  linesChanged: number;
  findings: ReviewFinding[];
  summary: string;
}
```

## Git Hook Usage

Add to `.git/hooks/post-commit`:

```bash
#!/bin/sh
bun -e "
import { reviewRecentCommits, formatForTUI } from './packages/proactive/code-reviewer.ts';
const review = await reviewRecentCommits({ commitCount: 1 });
if (review.findings.length > 0) console.log(formatForTUI(review));
"
```

## Config

| Option | Default | Description |
|--------|---------|-------------|
| `commitCount` | 1 | How many recent commits to diff |
| `model` | `qwen3:0.6b` | Ollama model for review |
| `ollamaUrl` | `http://localhost:11434` | Ollama endpoint |
| `cwd` | `process.cwd()` | Git repo root |
| `maxDiffChars` | 8000 | Truncation limit for large diffs |

## Success Metric

- Catches at least 1 real issue per 5 commits on this repo (validated manually over a week).
- Runs in under 10 seconds on a typical single-commit diff with qwen3:0.6b.

## Integration Points

- **TUI**: Import `formatForTUI()` and display in activity feed or as a notification.
- **Telegram**: Import `formatForTelegram()` and send via the existing bot token.
- **Daemon**: Can be wired into the daemon's cron/event system for periodic scans.
- **Git hook**: Lightweight post-commit hook (see above).

## Estimated Size

- 1 new file, ~150 lines
- 0 existing files modified
