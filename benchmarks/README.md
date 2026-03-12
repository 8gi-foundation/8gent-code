# 8gent Code Benchmark Suite

Comprehensive coding benchmarks to test and showcase 8gent's maximum coding abilities.

Following Andrej Karpathy's auto-research methodology, this suite provides:

## Benchmark Categories

1. **File Manipulation** - Create, edit, refactor operations
2. **Multi-file Coordination** - Dependencies, imports, cross-file changes
3. **Bug Fixing** - Debug and fix various bug patterns
4. **Feature Implementation** - Add new features to existing code
5. **Code Review** - Identify issues and suggest improvements
6. **Test Generation** - Create comprehensive test suites
7. **Documentation** - Generate accurate documentation

## Grading Rubrics

Each benchmark is scored on:
- **Correctness** (0-100): Does the output work correctly?
- **Code Quality** (0-100): Is the code clean, readable, maintainable?
- **Efficiency** (0-100): Is the solution performant?
- **Best Practices** (0-100): Does it follow industry standards?
- **Token Efficiency** (actual/expected ratio): How efficiently were tokens used?

## Running Benchmarks

```bash
# Run all benchmarks
bun run benchmarks/runner.ts

# Run specific category
bun run benchmarks/runner.ts --category bug-fixing

# Run single benchmark
bun run benchmarks/runner.ts --bench BF001

# Output formats
bun run benchmarks/runner.ts --output json
bun run benchmarks/runner.ts --output markdown
```

## Directory Structure

```
benchmarks/
├── README.md
├── runner.ts              # Main benchmark runner
├── grader.ts              # Grading logic
├── types.ts               # Type definitions
├── fixtures/              # Test fixtures (input code)
├── expected/              # Expected outputs
├── categories/
│   ├── file-manipulation/
│   ├── multi-file/
│   ├── bug-fixing/
│   ├── feature-implementation/
│   ├── code-review/
│   ├── test-generation/
│   └── documentation/
└── results/               # Benchmark results
```
