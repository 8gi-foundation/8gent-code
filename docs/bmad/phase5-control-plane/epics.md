# Phase 5: Control Plane & Tenant Isolation — Epics & Stories

## Epic 1: Control Plane Package

### Stories

- **CP-1.1** Create `packages/control-plane/types.ts` with TenantConfig, AdminDashboard, UsageReport, BillingPlan types
- **CP-1.2** Create `packages/control-plane/tenant.ts` with tenant CRUD and subdomain mapping
- **CP-1.3** Create `packages/control-plane/analytics.ts` with growth metrics and usage aggregation
- **CP-1.4** Create `packages/control-plane/billing.ts` with plan definitions and Stripe stubs
- **CP-1.5** Create `packages/control-plane/index.ts` ControlPlane aggregator class

## Epic 2: Admin Convex Functions

### Stories

- **CP-2.1** Create `packages/db/convex/admin.ts` with admin dashboard aggregate query
- **CP-2.2** Add paginated user list query with usage stats
- **CP-2.3** Add system health query (active sessions, error rates, model distribution)
- **CP-2.4** Add usage timeseries query for charting

## Epic 3: Dashboard App — Core

### Stories

- **CP-3.1** Scaffold `apps/dashboard/` with Next.js 16, Tailwind, Clerk, Convex
- **CP-3.2** Create root layout with ClerkProvider + ConvexProvider + dark theme
- **CP-3.3** Create admin dashboard page with stats cards and charts
- **CP-3.4** Create auth middleware (Clerk + admin role check)

## Epic 4: Dashboard App — Components

### Stories

- **CP-4.1** Create StatsCard component (value, label, trend indicator)
- **CP-4.2** Create UsageChart component (Recharts line chart, last 30 days)
- **CP-4.3** Create SessionTable component (recent sessions across all users)
- **CP-4.4** Create UserTable component (paginated user list)

## Epic 5: Dashboard App — User Management

### Stories

- **CP-5.1** Create user list page with search and filters
- **CP-5.2** Create user detail page with profile, sessions, usage charts
- **CP-5.3** Add plan management (upgrade/downgrade) to user detail

## Epic 6: Tenant Isolation & Subdomain Routing

### Stories

- **CP-6.1** Implement subdomain extraction in Next.js middleware
- **CP-6.2** Wire subdomain to tenant config lookup
- **CP-6.3** Add tenant context to request pipeline
- **CP-6.4** Add usage limit enforcement at session start

## Priority Order

1. Epic 1 (types + business logic) — foundation
2. Epic 2 (Convex admin queries) — data layer
3. Epic 3 (dashboard scaffold) — app shell
4. Epic 4 (components) — UI building blocks
5. Epic 5 (user management) — admin workflows
6. Epic 6 (tenant isolation) — multi-tenancy
