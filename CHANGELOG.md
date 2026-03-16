# Changelog

All notable changes to 8gent Code will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- **Fix shell command injection (critical):** Git and GitHub CLI commands now use `spawn()` with explicit argument arrays instead of `sh -c` string interpolation, preventing LLM-generated arguments from executing arbitrary shell commands.
- **Fix path traversal (high):** All file-access methods now validate resolved paths stay within the working directory via `safePath()` helper, blocking `../../` and absolute path escapes.
- **Remove unsafe stdin auto-answer (medium):** Removed `setInterval` hack that sent `\n` to stdin every second, which could silently confirm destructive interactive prompts.

### Fixed
- `git_add` with space-separated file lists now correctly splits into individual arguments instead of passing as a single string.
- `git_log` count parameter now uses `Math.floor(Math.abs(...))` to reject decimal values that git would reject.
- `safePath()` calls in `getOutline()` and `getSymbol()` now wrapped in try/catch for consistent error handling.
- `safeExec()` uses dynamic `import()` instead of `require()` for ESM consistency.

## [0.3.0] - 2026-03-12

### Added
- **Autoresearch harness**: Karpathy-style iterative prompt improvement loop
- **44 benchmarks across 12 categories**: Bug fixing, feature implementation, file manipulation, test generation, code review, documentation, multi-file, Three.js/3D, React Native/Expo, Next.js, creative, human skills
- **OpenRouter free models**: Support for free cloud models (Qwen3, Llama 3.3, Gemma 3, DeepSeek V3) for users without local GPUs
- **Enhanced system prompts**: Autoresearch-tuned patterns for bug fixing, file manipulation, and feature implementation
- **Benchmark grading rubric**: Correctness 40%, Code Quality 25%, Efficiency 20%, Best Practices 15%
- **Results tracking**: TSV-based results log with iteration-level tracking

### Changed
- **System prompt architecture**: Composable segments (IDENTITY, ARCHITECTURE, BMAD, TOOL_PATTERNS, ERROR_RECOVERY)
- **Context compression**: Token-efficient conversation history with decay rates
- **Provider abstraction**: Unified provider interface supporting Ollama and OpenRouter

### Results
- 8gent beats Claude Code on 4/5 core benchmarks (race conditions, null refs, validation, LRU caching)
- Best iteration: 3/5 simultaneous wins
- Autoresearch-tuned prompts improve local model performance by 15-50 points on targeted tasks

## [0.2.0] - 2025-03-11

### Added
- **Multi-provider support**: Ollama, OpenRouter, Groq, Grok, OpenAI, Anthropic, Mistral, Together, Fireworks, Replicate
- **Multi-language support**: 30+ languages with `/language` commands
- **Voice TTS system**: Task completion announcements via macOS `say` command
- **GentlemanInput**: Claude Code-style input with ghost text suggestions
- **Provider commands**: `/provider list`, `/provider set`, `/provider key`
- **Voice commands**: `/voice on/off/test`, `/voice voice <name>`, `/voice settings`
- **Language commands**: `/language`, `/language set <code>`, `/language list`
- Animated TUI components with Ink
- Status bar with model info and token savings
- Evidence panel for validation reports

### Changed
- Improved BMAD method implementation
- Enhanced system prompt with personality
- Better AST-first code navigation
- Updated documentation for v0.2.0

### Fixed
- Token efficiency improvements
- Better error handling for tool execution

## [0.1.0] - 2025-03-01

### Added
- Initial release
- Core agent loop with Ollama integration
- Tool execution (file operations, terminal, git)
- Basic TUI with message list
- BMAD method planning
- AST extraction for token savings
- Global installation via symlink

[Unreleased]: https://github.com/PodJamz/8gent-code/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/PodJamz/8gent-code/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/PodJamz/8gent-code/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/PodJamz/8gent-code/releases/tag/v0.1.0
