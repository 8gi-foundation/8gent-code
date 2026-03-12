# Benchmarks

8gent includes a comprehensive benchmark suite with 44 tests across 12 categories, designed to evaluate coding agent performance across diverse domains.

## Grading Rubric

All benchmarks use a consistent 100-point rubric:

| Criteria | Weight | Description |
|----------|--------|-------------|
| Correctness | 40% | Does the code solve the problem? |
| Code Quality | 25% | Clean, readable, idiomatic code |
| Efficiency | 20% | Algorithmic and resource efficiency |
| Best Practices | 15% | Error handling, edge cases, patterns |

## Categories

### Core (5 benchmarks)

These are the primary benchmarks used in autoresearch iteration:

| ID | Category | Task | Claude Baseline |
|----|----------|------|----------------|
| BF001 | Bug Fixing | Fix race condition in concurrent counter | 95 |
| BF002 | Bug Fixing | Fix memory leak in subscription manager | 92 |
| BF003 | Bug Fixing | Fix null reference in user lookup chain | 90 |
| FM001 | File Manipulation | Add input validation to processData | 88 |
| FI001 | Feature Implementation | Add LRU caching with TTL to API client | 93 |

### Bug Fixing (5 total)

- BF001: Race conditions in shared state
- BF002: Memory leaks in subscriptions
- BF003: Null reference errors in deep chains
- BF004: Off-by-one errors in pagination
- BF005: Async/await error propagation

### Feature Implementation (3)

- FI001: LRU cache with TTL, stats, and pattern invalidation
- FI002: Authentication middleware with JWT
- FI003: REST API endpoint with validation

### File Manipulation (3)

- FM001: Input validation with type guards
- FM002: Refactor class to functional composition
- FM003: Database migration script

### Test Generation (3)

- TG001: Unit tests for utility functions
- TG002: Edge case coverage for parsers
- TG003: Mock-based tests for API clients

### Code Review (3)

- CR001: Security vulnerability detection
- CR002: Performance bottleneck identification
- CR003: Pattern and anti-pattern recognition

### Documentation (3)

- DC001: API documentation generation
- DC002: README creation from codebase
- DC003: Inline comment quality

### Multi-File (3)

- MF001: Cross-file refactoring
- MF002: Dependency update propagation
- MF003: Module extraction

### Three.js / 3D (3)

- 3D001: Rotating cube with lighting
- 3D002: GLTF model loader with animation
- 3D003: Custom shader with uniforms

### React Native / Expo (3)

- RN001: Animated FlatList with gestures
- RN002: Bottom sheet with snap points
- RN003: Camera with permissions handling

### Next.js (3)

- NX001: Server components with streaming
- NX002: Server actions with validation
- NX003: Middleware with auth and routing

### Creative (3)

- CV001: Song lyrics generation
- CV002: Tone.js music composition
- CV003: p5.js generative art

### Human Skills (10)

- HS001: Autonomous task decomposition
- HS002: Calendar and time management
- HS003: Meal planning with constraints
- HS004: Budget allocation
- HS005: Conflict resolution simulation
- HS006: Networking and outreach
- HS007: Trolley problem analysis
- HS008: Technology ethics debate
- HS009: Philosophical argument construction
- HS010: Cultural sensitivity assessment

## Running Benchmarks

```bash
# Run full autoresearch loop (runs until interrupted)
bun run benchmarks/autoresearch/harness.ts

# Results are logged to:
# - benchmarks/results.tsv (structured data)
# - benchmarks/autoresearch/run.log (detailed output)
```

## Results Format

Results are stored in TSV format:

```
iteration	benchmark_id	claude_baseline	8gent_score	gap	status	action
1	BF001	95	100	-5	improved	none
1	BF002	92	50	42	regressed	pattern added
```

## Adding New Benchmarks

1. Create a fixture in `benchmarks/fixtures/<category>/`
2. Add the benchmark definition to `benchmarks/categories/<category>/benchmarks.ts`
3. Include grading criteria matching the rubric
4. Run the harness to establish baselines
