---
name: performance-analyze
trigger: /performance-analyze
description: Identifies performance bottlenecks, analyzes complexity, and suggests optimizations. Focuses on response time, memory usage, CPU efficiency, and database queries.
category: analysis
tools: [profile, trace, benchmark, memory_snapshot, ast_complexity]
---

# Performance Analyze Skill

Analyzes code for performance bottlenecks, algorithmic complexity issues, and optimization opportunities. Provides data-driven recommendations with estimated impact.

## What It Analyzes

### Algorithm Complexity
- Time complexity (O(n), O(n²), O(log n))
- Space complexity and memory allocation patterns
- Nested loops and recursive call depth
- Inefficient data structure usage

### Database Performance
- N+1 query problems
- Missing indexes on frequent queries
- Slow queries (>100ms)
- Inefficient joins and subqueries
- Connection pool exhaustion

### Memory Issues
- Memory leaks
- Large object allocations
- Unclosed resources (files, connections)
- Excessive garbage collection
- Buffer overflow risks

### CPU Bottlenecks
- Blocking operations in event loop
- Synchronous file I/O
- Heavy computation in request handlers
- Inefficient string operations
- Excessive regex complexity

### Network & I/O
- Excessive HTTP requests
- Missing connection reuse
- Large payload sizes
- No compression enabled
- Inefficient serialization

## Usage

Analyze entire codebase:
```
/performance-analyze
```

Profile specific file:
```
/performance-analyze src/api/users.ts
```

Focus on database queries:
```
/performance-analyze --focus=database
```

With benchmark comparison:
```
/performance-analyze --benchmark=baseline.json
```

## Output Format

```
PERFORMANCE ANALYSIS REPORT
===========================

Project: my-api
Analysis Date: 2026-03-23
Files Analyzed: 28
Functions Profiled: 342

PERFORMANCE SCORE: 62/100 (C+)

CRITICAL BOTTLENECKS: 3
────────────────────────────

[CRITICAL] N+1 Query Problem
  File: src/api/posts.ts:45-67
  Function: getUserPosts()
  Issue: Fetching users in loop (234 queries for 234 posts)
  Impact: Response time 2.3s → 50ms (98% improvement possible)
  Current Complexity: O(n) queries
  
  Current Code:
  ```typescript
  for (const post of posts) {
    const user = await db.query('SELECT * FROM users WHERE id = ?', [post.userId]);
    post.author = user;
  }
  ```
  
  Optimized:
  ```typescript
  const userIds = posts.map(p => p.userId);
  const users = await db.query('SELECT * FROM users WHERE id IN (?)', [userIds]);
  const userMap = new Map(users.map(u => [u.id, u]));
  posts.forEach(p => p.author = userMap.get(p.userId));
  ```
  
  Estimated Improvement:
  - Response time: 2.3s → 50ms (46x faster)
  - Database load: 234 queries → 2 queries
  - Memory: Constant

[CRITICAL] Memory Leak
  File: src/cache/manager.ts:89
  Function: CacheManager.set()
  Issue: Cache grows unbounded (no eviction policy)
  Impact: Memory usage grows linearly with time
  Current: 2.4 GB after 6 hours
  
  Fix: Add LRU eviction policy
  ```typescript
  class LRUCache {
    constructor(maxSize = 1000) {
      this.cache = new Map();
      this.maxSize = maxSize;
    }
    
    set(key, value) {
      if (this.cache.size >= this.maxSize) {
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }
      this.cache.set(key, value);
    }
  }
  ```

[CRITICAL] O(n²) Algorithm
  File: src/utils/dedup.ts:23
  Function: removeDuplicates()
  Issue: Nested loop for duplicate removal
  Complexity: O(n²) where n = array length
  Impact: 10s for 10,000 items
  
  Current:
  ```typescript
  function removeDuplicates(arr) {
    const result = [];
    for (const item of arr) {
      if (!result.includes(item)) {  // O(n) lookup
        result.push(item);
      }
    }
    return result;
  }
  ```
  
  Optimized:
  ```typescript
  function removeDuplicates(arr) {
    return [...new Set(arr)];  // O(n) with Set
  }
  ```
  
  Estimated Improvement:
  - Time: O(n²) → O(n)
  - 10s → 10ms for 10,000 items (1000x faster)

HIGH PRIORITY OPTIMIZATIONS: 5
───────────────────────────────

[HIGH] Blocking File I/O
  File: src/middleware/logger.ts:34
  Issue: Synchronous fs.writeFileSync() in request handler
  Impact: Blocks event loop, reduces throughput by 60%
  Fix: Use async fs.promises.writeFile()

[HIGH] Missing Database Index
  Query: SELECT * FROM orders WHERE user_id = ? AND status = ?
  Executions: 45,234/hour
  Avg Time: 234ms
  Issue: No composite index on (user_id, status)
  Fix: CREATE INDEX idx_orders_user_status ON orders(user_id, status)
  Estimated: 234ms → 5ms (47x faster)

[HIGH] Large Bundle Size
  File: src/client/app.tsx
  Issue: Entire lodash imported (71 KB)
  Impact: Slow initial page load
  Current: import _ from 'lodash'
  Fix: import debounce from 'lodash/debounce'
  Savings: 71 KB → 2 KB

[HIGH] Inefficient Regex
  Pattern: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).*$/
  Executions: 12,000/second (password validation)
  Avg Time: 2.3ms per check
  Issue: Catastrophic backtracking on long inputs
  Fix: Use simpler sequential checks

[HIGH] Missing Compression
  Endpoint: GET /api/posts
  Response Size: 2.4 MB uncompressed
  Issue: No gzip/brotli compression
  Fix: Enable compression middleware
  Savings: 2.4 MB → 180 KB (93% reduction)

MEDIUM OPTIMIZATIONS: 12
────────────────────────────

[MEDIUM] Premature Object Creation
  File: src/utils/format.ts:45
  Issue: Creating Date objects in tight loop
  Fix: Cache formatter, reuse instances

[MEDIUM] String Concatenation in Loop
  File: src/templates/render.ts:89
  Issue: Using += for string building
  Fix: Use array join or template literals

[MEDIUM] Missing Request Caching
  Endpoint: GET /api/config
  Frequency: 1,200 req/min
  Issue: Same response every time, no caching
  Fix: Add Cache-Control: max-age=300

BENCHMARKS
──────────────────────────

Function Performance (top 10 slowest):

1. getUserPosts()           2.3s   ████████████████████
2. renderTemplate()         450ms  ████████
3. processPayment()         380ms  ███████
4. generateReport()         290ms  ██████
5. validateInput()          120ms  ███
6. fetchUserData()          95ms   ██
7. calculateTotals()        78ms   ██
8. formatResponse()         45ms   █
9. logRequest()             23ms   █
10. parseQuery()            12ms   

Database Queries (slowest 5):

1. SELECT posts JOIN users  234ms  ████████████
2. UPDATE orders SET...     145ms  ███████
3. SELECT * FROM logs...    98ms   █████
4. INSERT INTO metrics...   67ms   ████
5. DELETE FROM cache...     34ms   ██

Memory Usage Over Time:

Hour 1:  512 MB  ████
Hour 2:  890 MB  ███████
Hour 3:  1.2 GB  ██████████
Hour 4:  1.8 GB  ███████████████
Hour 5:  2.4 GB  ████████████████████  ← Growing!
Hour 6:  3.1 GB  █████████████████████████

ESTIMATED IMPROVEMENTS
──────────────────────────

If all optimizations applied:

Response Time:  2.3s → 120ms  (95% faster)
Throughput:     100 req/s → 850 req/s  (8.5x)
Memory:         3.1 GB → 450 MB  (85% reduction)
Database Load:  1,200 q/s → 80 q/s  (93% reduction)
Bundle Size:    2.8 MB → 340 KB  (88% smaller)

RECOMMENDATIONS
──────────────────────────

Immediate (This Week):
1. Fix N+1 queries in posts endpoint
2. Add LRU eviction to cache
3. Replace O(n²) dedup with Set
4. Add database indexes
5. Enable compression

Short Term (This Month):
1. Async file I/O everywhere
2. Optimize regex patterns
3. Add request caching
4. Code splitting for client bundle
5. Connection pooling

Long Term:
1. Add APM monitoring (DataDog, New Relic)
2. Implement performance budgets
3. Regular profiling in CI/CD
4. Load testing before deploys
5. Database query plan analysis
```

## Analysis Process

1. **Static Analysis**: Parse code for complexity patterns
2. **Profiling**: Inject instrumentation, measure actual execution
3. **Database Analysis**: Analyze slow query logs, missing indexes
4. **Memory Profiling**: Heap snapshots, allocation tracking
5. **Benchmark**: Compare against baseline or similar codebases
6. **Impact Estimation**: Calculate potential improvements
7. **Generate Report**: Prioritize by impact × effort

## Metrics Tracked

- **Response Time**: P50, P95, P99 latencies
- **Throughput**: Requests per second
- **CPU Usage**: Per-handler CPU time
- **Memory**: Heap size, allocation rate, GC pauses
- **Database**: Query count, slow queries, connection pool
- **Network**: Request count, payload sizes, bandwidth

## Integration

Works with:
- `/code-review` - General quality + performance focus
- `/test-generator` - Generate performance tests
- `/documentation-writer` - Document performance characteristics

## Configuration

Options:
- `--focus=database` - Database performance only
- `--focus=memory` - Memory leak detection
- `--focus=cpu` - CPU bottleneck analysis
- `--benchmark=file.json` - Compare against baseline
- `--threshold=100ms` - Custom slow threshold
- `--profile` - Enable detailed profiling (slower)

## Examples

### Example 1: Quick Analysis
```
/performance-analyze src/api/
```

Output:
```
✓ Analyzed 15 files
⚠ 3 critical bottlenecks
⚠ 8 optimizations available
Score: 62/100 (C+)
Potential: 95% faster if fixed
```

### Example 2: Database Focus
```
/performance-analyze --focus=database
```

Output:
```
Database Performance Analysis
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Slow Queries: 23
Missing Indexes: 8
N+1 Queries: 5
Connection Issues: 2

Top Issue: Posts query (234ms avg)
Fix: Add index on (user_id, created_at)
Impact: 234ms → 8ms
```

### Example 3: Memory Profile
```
/performance-analyze --focus=memory
```

Output:
```
Memory Analysis
━━━━━━━━━━━━━━━
Current: 2.4 GB
Baseline: 512 MB
Growth: 380 MB/hour

Leak Detected: CacheManager
Cause: No eviction policy
Fix: Implement LRU
Savings: 1.9 GB
```

## Notes

- Measures real-world impact, not theoretical complexity
- Prioritizes by actual bottleneck severity (Amdahl's Law)
- Provides before/after benchmarks when possible
- Integrates with APM tools (DataDog, New Relic, Prometheus)
- Can run in CI/CD to detect performance regressions
- Safe profiling - minimal overhead in production
