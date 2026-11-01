# Phase 5: Control Plane & Tenant Isolation — Architecture

## System Overview

```
                    +-------------------+
                    |   apps/dashboard  |
                    |  (Next.js 16)     |
                    |  Port 3001        |
                    +--------+----------+
                             |
              +--------------+--------------+
              |              |              |
    +---------v--+  +--------v---+  +-------v--------+
    |   Clerk    |  |   Convex   |  |    Stripe      |
    | (Auth/RBAC)|  | (Real-time)|  | (Billing stubs)|
    +------------+  +------+-----+  +----------------+
                           |
              +------------+------------+
              |            |            |
        +-----v----+ +----v-----+ +----v------+
        |  users   | | sessions | |   usage   |
        +----------+ +----------+ +-----------+
```

## Package Structure

### `packages/control-plane/`

Framework-agnostic business logic for tenant management, analytics, and billing.

```
packages/control-plane/
  index.ts        — ControlPlane class (aggregator)
  types.ts        — TenantConfig, AdminDashboard, UsageReport, BillingPlan
  tenant.ts       — Tenant CRUD + subdomain mapping
  analytics.ts    — Usage analytics + growth metrics
  billing.ts      — Plan definitions + Stripe stubs
  package.json
```

### `packages/db/convex/admin.ts`

Admin-only Convex functions that aggregate across all users. These power the dashboard queries.

### `apps/dashboard/`

Next.js 16 App Router application. Separate from `apps/debugger/` (which is for session debugging, not admin).

```
apps/dashboard/
  app/
    layout.tsx           — ClerkProvider + ConvexProvider + dark theme
    page.tsx             — Admin dashboard (stats, charts, tables)
    users/
      page.tsx           — User management list
      [id]/page.tsx      — User detail view
    components/
      StatsCard.tsx      — Stat card with value, label, trend
      UsageChart.tsx     — Recharts line chart
      SessionTable.tsx   — Recent sessions table
      UserTable.tsx      — User list table
  middleware.ts          — Clerk auth + admin role check
  tailwind.config.ts     — 8gent design tokens
  tsconfig.json
  package.json
```

## Subdomain Routing

Subdomain routing is handled via Next.js middleware:

1. Request to `username.8gent.app` hits middleware
2. Middleware extracts subdomain from `Host` header
3. Looks up tenant config by subdomain
4. Sets tenant context in request headers
5. Rewrites to the appropriate route

For local development, use `username.localhost:3001`.

## Auth & RBAC

- **Clerk** manages authentication and user metadata
- Admin role stored in Clerk's `publicMetadata.role`
- Middleware checks `role === "admin"` for dashboard access
- Convex admin functions verify identity server-side

## Data Flow

1. TUI sessions write to Convex (sessions, usage tables) — already exists
2. Admin dashboard reads from Convex via admin queries
3. Analytics aggregate across all users (no per-user index needed)
4. Billing reads daily usage aggregates for invoice calculation

## Technology Choices

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Dashboard | Next.js 16 | Same stack as debugger, App Router |
| Charts | Recharts | Lightweight, React-native, SSR-safe |
| Auth | Clerk | Already integrated in Phase 2 |
| DB | Convex | Already integrated, real-time subscriptions |
| Billing | Stripe | Industry standard, good SDK |
| Styling | Tailwind v4 | Same as debugger |
