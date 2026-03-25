# Quarantine: Contributor Guide

## Status: Ready for Review

## What

Comprehensive rewrite of `CONTRIBUTING.md` covering the full project as it exists today - 9 Powers, benchmark system, quarantine branch workflow, brand rules, and all runnable commands.

## Why

The previous CONTRIBUTING.md was outdated - it referenced old directory structures, missing packages, and did not cover the benchmark system, 9 Powers pattern, quarantine branch workflow, daemon, or Lil Eight. New contributors had no way to understand the actual project without reading CLAUDE.md (which is internal context, not a contributor doc).

## What Changed

- `CONTRIBUTING.md` - full rewrite (~230 lines)

## Sections Covered

1. **Dev environment setup** - bun install, ollama model pull, optional deps
2. **Running things** - TUI, daemon, Lil Eight, benchmarks, CLI
3. **Project structure** - apps/, packages/, benchmarks/ with current contents
4. **9 Powers** - table of all 9 power packages with descriptions
5. **Adding a new package** - step-by-step following the Powers pattern
6. **Adding a benchmark** - BenchmarkDefinition type, categories, grading rules
7. **Creating a skill** - registration pattern
8. **Code style** - em dash ban, purple ban, TUI color rules, brand
9. **PR process** - quarantine branches, review criteria, commit conventions
10. **Architecture principles** - local-first, self-evolving, hyper-personal

## Scope

Single file rewritten. One quarantine doc added. No existing functionality affected.

## Review Checklist

- [ ] Accurate project structure
- [ ] No em dashes
- [ ] No purple references
- [ ] Commands actually work
- [ ] Brand rules correctly stated
