/**
 * 8gent Code Benchmarks - Next.js Web Development
 *
 * Tests modern web development with Next.js App Router
 */

import type { BenchmarkDefinition } from "../../types";

export const nextjsBenchmarks: BenchmarkDefinition[] = [
  {
    id: "NX001",
    name: "Server Component Data Fetching",
    category: "nextjs",
    difficulty: "medium",
    description: "Implement data fetching with Server Components and Suspense",
    task: `Create a Next.js page that:
1. Uses Server Component for data fetching
2. Shows loading state with Suspense
3. Handles errors with error boundary
4. Implements ISR with revalidation
5. Types the fetched data properly`,
    expectedBehavior: "Page loads with skeleton, data appears, handles errors gracefully",
    fixture: "fixtures/nextjs/NX001-server-fetch.tsx",
    rubric: {
      correctness: {
        weight: 40,
        criteria: [
          "Server Component fetches data",
          "Suspense shows loading",
          "Error boundary catches errors",
          "Revalidation works",
        ],
      },
      codeQuality: {
        weight: 25,
        criteria: [
          "Proper async/await",
          "Clean component separation",
          "TypeScript types",
        ],
      },
      efficiency: {
        weight: 20,
        criteria: [
          "Uses fetch cache",
          "Parallel data fetching",
          "Minimal client JS",
        ],
      },
      bestPractices: {
        weight: 15,
        criteria: [
          "Uses loading.tsx",
          "Uses error.tsx",
          "Proper metadata",
        ],
      },
    },
    validators: [
      { type: "ast", config: { mustContain: ["Suspense", "async", "revalidate"] } },
    ],
    expectedTokens: 900,
    timeLimit: 150,
  },
  {
    id: "NX002",
    name: "Server Actions Form",
    category: "nextjs",
    difficulty: "medium",
    description: "Build a form with Server Actions and validation",
    task: `Create a contact form that:
1. Uses Server Actions for submission
2. Validates with Zod
3. Shows pending state with useFormStatus
4. Handles errors gracefully
5. Shows success message
6. Prevents double submission`,
    expectedBehavior: "Form submits, shows loading, validates, handles errors/success",
    fixture: "fixtures/nextjs/NX002-server-action-form.tsx",
    rubric: {
      correctness: {
        weight: 40,
        criteria: [
          "Server Action executes",
          "Validation works",
          "Pending state shows",
          "Success/error handled",
        ],
      },
      codeQuality: {
        weight: 25,
        criteria: [
          "Clean action separation",
          "Proper Zod schema",
          "TypeScript inference",
        ],
      },
      efficiency: {
        weight: 20,
        criteria: [
          "No unnecessary re-renders",
          "Efficient validation",
          "Progressive enhancement",
        ],
      },
      bestPractices: {
        weight: 15,
        criteria: [
          "Uses useFormState",
          "Accessible form",
          "CSRF protection",
        ],
      },
    },
    validators: [
      { type: "ast", config: { mustContain: ["use server", "useFormStatus", "z.object"] } },
    ],
    expectedTokens: 1000,
    timeLimit: 180,
  },
  {
    id: "NX003",
    name: "Middleware Authentication",
    category: "nextjs",
    difficulty: "hard",
    description: "Implement route protection with middleware",
    task: `Create authentication middleware that:
1. Checks for auth token in cookies
2. Protects /dashboard/* routes
3. Redirects unauthenticated to /login
4. Passes user info to protected routes
5. Handles token expiration
6. Works with edge runtime`,
    expectedBehavior: "Protected routes redirect without token, work with valid token",
    fixture: "fixtures/nextjs/NX003-auth-middleware.ts",
    rubric: {
      correctness: {
        weight: 40,
        criteria: [
          "Middleware intercepts routes",
          "Auth check works",
          "Redirect happens",
          "Token validation correct",
        ],
      },
      codeQuality: {
        weight: 25,
        criteria: [
          "Clean middleware logic",
          "Proper matcher config",
          "TypeScript types",
        ],
      },
      efficiency: {
        weight: 20,
        criteria: [
          "Edge-compatible code",
          "Minimal token parsing",
          "No unnecessary checks",
        ],
      },
      bestPractices: {
        weight: 15,
        criteria: [
          "Uses NextRequest/Response",
          "Proper cookie handling",
          "Handles edge cases",
        ],
      },
    },
    validators: [
      { type: "ast", config: { mustContain: ["middleware", "NextRequest", "cookies", "redirect"] } },
    ],
    expectedTokens: 800,
    timeLimit: 180,
  },
  {
    id: "NX004",
    name: "Parallel Routes and Slots",
    category: "nextjs",
    difficulty: "hard",
    description: "Implement dashboard with parallel routes",
    task: `Create a dashboard layout with:
1. Parallel routes for stats, chart, and table
2. Independent loading states per slot
3. Error handling per slot
4. Default fallbacks
5. Conditional slot rendering`,
    expectedBehavior: "Slots load independently, errors isolated, layout works",
    fixture: "fixtures/nextjs/NX004-parallel-routes/",
    rubric: {
      correctness: {
        weight: 40,
        criteria: [
          "Parallel routes render",
          "Slots are independent",
          "Error isolation works",
          "Defaults render",
        ],
      },
      codeQuality: {
        weight: 25,
        criteria: [
          "Clean slot organization",
          "Proper folder structure",
          "TypeScript props",
        ],
      },
      efficiency: {
        weight: 20,
        criteria: [
          "Parallel data loading",
          "Minimal waterfalls",
          "Streaming enabled",
        ],
      },
      bestPractices: {
        weight: 15,
        criteria: [
          "Uses @folder convention",
          "Proper default.tsx",
          "Accessible layout",
        ],
      },
    },
    validators: [
      { type: "regex", config: { pattern: "@\\w+", files: ["**/layout.tsx"] } },
    ],
    expectedTokens: 1200,
    timeLimit: 240,
  },
];

export default nextjsBenchmarks;
