# Changelog

All notable changes to 8gent Code will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/PodJamz/8gent-code/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/PodJamz/8gent-code/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/PodJamz/8gent-code/releases/tag/v0.1.0
