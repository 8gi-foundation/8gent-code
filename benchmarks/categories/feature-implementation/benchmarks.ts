/**
 * Feature Implementation Benchmarks
 *
 * Tests ability to implement new features from requirements.
 */

import type { BenchmarkDefinition } from "../../types";

export const featureImplementationBenchmarks: BenchmarkDefinition[] = [
  {
    id: "FI001",
    name: "Implement Caching Layer",
    category: "feature-implementation",
    difficulty: "hard",
    description: "Implement a full-featured caching layer for data fetching",
    prompt: `Read fixtures/feature-implementation/FI001-add-caching.ts and implement CachedDataFetcher:

Requirements:
1. Extend or wrap DataFetcher with caching
2. Cache options: { ttl: number, maxSize: number }
3. Implement LRU eviction when maxSize is exceeded
4. TTL-based expiration (items expire after ttl milliseconds)
5. getStats() returns { hits, misses, size, evictions }
6. invalidate(pattern: string | RegExp) removes matching entries
7. clear() removes all entries
8. Cached keys should be based on method + arguments

Implementation notes:
- Use Map or custom data structure for O(1) operations
- Track access order for LRU
- Thread-safe (handle concurrent requests for same key)

Provide the complete implementation.`,
    fixtures: ["fixtures/feature-implementation/FI001-add-caching.ts"],
    expectedTokens: 2000,
    timeLimit: 150000,
    rubric: {
      correctness: {
        weight: 0.4,
        checks: [
          {
            name: "has-cache-class",
            description: "Implements CachedDataFetcher class",
            points: 10,
            validator: "regex",
            config: { pattern: "class\\s+CachedDataFetcher|function\\s+createCached", countMin: 1 },
          },
          {
            name: "has-ttl",
            description: "Implements TTL expiration",
            points: 15,
            validator: "regex",
            config: { pattern: "ttl|expire|timestamp|Date\\.now|setTimeout", countMin: 2 },
          },
          {
            name: "has-lru",
            description: "Implements LRU eviction",
            points: 15,
            validator: "regex",
            config: { pattern: "lru|evict|oldest|order|Map|delete.*set", countMin: 2 },
          },
          {
            name: "has-stats",
            description: "Implements getStats()",
            points: 10,
            validator: "regex",
            config: { pattern: "getStats|hits|misses|evictions", countMin: 3 },
          },
          {
            name: "has-invalidate",
            description: "Implements invalidate(pattern)",
            points: 10,
            validator: "regex",
            config: { pattern: "invalidate.*pattern|RegExp|match|test", countMin: 2 },
          },
        ],
      },
      codeQuality: {
        weight: 0.25,
        checks: [
          {
            name: "type-safe",
            description: "Uses proper TypeScript generics",
            points: 15,
            validator: "regex",
            config: { pattern: "<T>|generic|Promise<T>", countMin: 2 },
          },
          {
            name: "interface-defined",
            description: "Defines proper interfaces",
            points: 10,
            validator: "regex",
            config: { pattern: "interface\\s+Cache|CacheOptions|CacheStats", countMin: 2 },
          },
        ],
      },
      efficiency: {
        weight: 0.2,
        checks: [
          {
            name: "o1-operations",
            description: "Uses O(1) data structures",
            points: 15,
            validator: "regex",
            config: { pattern: "Map|Set|Object\\.create\\(null\\)", countMin: 1 },
          },
        ],
      },
      bestPractices: {
        weight: 0.15,
        checks: [
          {
            name: "handles-concurrency",
            description: "Handles concurrent requests",
            points: 10,
            validator: "regex",
            config: { pattern: "pending|inflight|dedup|Promise.*resolve", countMin: 1 },
          },
        ],
      },
    },
    validation: {
      syntaxCheck: true,
      typeCheck: true,
      testExecution: false,
      customValidators: [],
    },
  },
  {
    id: "FI002",
    name: "Implement Middleware System",
    category: "feature-implementation",
    difficulty: "medium",
    description: "Implement a middleware pattern for request handling",
    prompt: `Read fixtures/feature-implementation/FI002-add-middleware.ts and implement:

1. Middleware type:
   type Middleware = (req, res, next) => Promise<Response>

2. MiddlewareHandler class extending RequestHandler:
   - use(middleware) to add middleware
   - Middleware executes in order
   - next() calls the next middleware
   - Can short-circuit by not calling next()

3. Implement these middleware examples:
   - loggingMiddleware: logs method, path, duration
   - authMiddleware: checks Authorization header
   - errorMiddleware: catches errors, returns 500
   - corsMiddleware: adds CORS headers

Requirements:
- Middleware can modify request and response
- Proper error handling
- Support async middleware

Provide the complete implementation.`,
    fixtures: ["fixtures/feature-implementation/FI002-add-middleware.ts"],
    expectedTokens: 1500,
    timeLimit: 120000,
    rubric: {
      correctness: {
        weight: 0.4,
        checks: [
          {
            name: "has-middleware-type",
            description: "Defines Middleware type",
            points: 10,
            validator: "regex",
            config: { pattern: "type\\s+Middleware|interface\\s+Middleware", countMin: 1 },
          },
          {
            name: "has-use-method",
            description: "Implements use() method",
            points: 15,
            validator: "regex",
            config: { pattern: "use\\s*\\(|addMiddleware", countMin: 1 },
          },
          {
            name: "has-next-function",
            description: "Implements next() pattern",
            points: 15,
            validator: "regex",
            config: { pattern: "next\\s*\\(|next\\s*=>|next:", countMin: 2 },
          },
          {
            name: "has-example-middlewares",
            description: "Implements example middlewares",
            points: 10,
            validator: "regex",
            config: { pattern: "loggingMiddleware|authMiddleware|errorMiddleware|corsMiddleware", countMin: 3 },
          },
        ],
      },
      codeQuality: {
        weight: 0.25,
        checks: [
          {
            name: "async-support",
            description: "Supports async middleware",
            points: 15,
            validator: "regex",
            config: { pattern: "async|await|Promise", countMin: 3 },
          },
          {
            name: "proper-typing",
            description: "Properly typed middleware",
            points: 10,
            validator: "regex",
            config: { pattern: ":\\s*Middleware|:\\s*Promise<Response>", countMin: 2 },
          },
        ],
      },
      efficiency: {
        weight: 0.2,
        checks: [
          {
            name: "compose-pattern",
            description: "Uses compose/reduce pattern",
            points: 15,
            validator: "regex",
            config: { pattern: "reduce|compose|chain|pipe", countMin: 1 },
          },
        ],
      },
      bestPractices: {
        weight: 0.15,
        checks: [
          {
            name: "error-handling",
            description: "Has proper error handling",
            points: 10,
            validator: "regex",
            config: { pattern: "try|catch|error|500", countMin: 2 },
          },
        ],
      },
    },
    validation: {
      syntaxCheck: true,
      typeCheck: true,
      testExecution: false,
      customValidators: [],
    },
  },
  {
    id: "FI003",
    name: "Implement Schema Validation",
    category: "feature-implementation",
    difficulty: "expert",
    description: "Implement a type-safe schema validation library",
    prompt: `Read fixtures/feature-implementation/FI003-add-validation.ts and implement a schema validation system:

1. Schema builders:
   - schema.string() with .min(), .max(), .email(), .regex()
   - schema.number() with .min(), .max(), .integer(), .positive()
   - schema.boolean()
   - schema.array(itemSchema) with .min(), .max()
   - schema.object({...}) for nested objects
   - schema.enum([...]) for enum values
   - .optional() and .nullable() modifiers
   - .custom(fn) for custom validators

2. Type inference:
   - InferType<typeof schema> should infer correct TypeScript type
   - Use generics to preserve type information

3. Validation:
   - schema.validate(input) returns { success, data, errors }
   - Errors should include path, message, and code
   - Support nested error paths like "user.address.city"

4. Usage example should work:
   const userSchema = schema.object({
     name: schema.string().min(1),
     email: schema.string().email(),
     age: schema.number().positive().integer(),
   });
   type User = InferType<typeof userSchema>;

Provide the complete implementation.`,
    fixtures: ["fixtures/feature-implementation/FI003-add-validation.ts"],
    expectedTokens: 3000,
    timeLimit: 180000,
    rubric: {
      correctness: {
        weight: 0.4,
        checks: [
          {
            name: "has-schema-builders",
            description: "Implements schema builders",
            points: 15,
            validator: "regex",
            config: { pattern: "schema\\.(string|number|boolean|object|array)", countMin: 4 },
          },
          {
            name: "has-validators",
            description: "Implements validators (.min, .max, etc)",
            points: 15,
            validator: "regex",
            config: { pattern: "\\.(min|max|email|regex|integer|positive)", countMin: 4 },
          },
          {
            name: "has-infer-type",
            description: "Implements InferType",
            points: 15,
            validator: "regex",
            config: { pattern: "InferType|infer|Output|Infer", countMin: 1 },
          },
          {
            name: "has-validate-method",
            description: "Implements validate method",
            points: 10,
            validator: "regex",
            config: { pattern: "\\.validate\\(|parse\\(|safeParse", countMin: 1 },
          },
        ],
      },
      codeQuality: {
        weight: 0.25,
        checks: [
          {
            name: "builder-pattern",
            description: "Uses builder/fluent pattern",
            points: 15,
            validator: "regex",
            config: { pattern: "return\\s+this|return\\s+new", countMin: 3 },
          },
          {
            name: "generic-types",
            description: "Uses advanced generics",
            points: 10,
            validator: "regex",
            config: { pattern: "<T|extends|infer", countMin: 5 },
          },
        ],
      },
      efficiency: {
        weight: 0.2,
        checks: [
          {
            name: "early-termination",
            description: "Fails fast on validation errors",
            points: 10,
            validator: "regex",
            config: { pattern: "return.*false|break|early|bail", countMin: 1 },
          },
        ],
      },
      bestPractices: {
        weight: 0.15,
        checks: [
          {
            name: "detailed-errors",
            description: "Provides detailed error messages",
            points: 10,
            validator: "regex",
            config: { pattern: "path|message|code|ValidationError", countMin: 2 },
          },
        ],
      },
    },
    validation: {
      syntaxCheck: true,
      typeCheck: true,
      testExecution: false,
      customValidators: [],
    },
  },
];

export default featureImplementationBenchmarks;
