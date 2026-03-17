# Phase 5: Control Plane & Tenant Isolation — Project Brief

## Vision

Transform 8gent from a single-user CLI tool into a multi-tenant platform where every user gets their own `username.8gent.app` subdomain. The control plane provides admin observability across all tenants, usage-based billing infrastructure, and operational monitoring.

## Goals

1. **Multi-Tenant Architecture** — Each user is a tenant with isolated data, configurable plans, and subdomain routing (`username.8gent.app`).
2. **Admin Observability** — Real-time dashboard showing user growth, active sessions, token consumption, model distribution, and system health.
3. **Billing Infrastructure** — Usage-based billing via Stripe with plan tiers (free/pro/team), daily token limits, and invoice generation.
4. **Session Monitoring** — Live view of active coding sessions across all tenants, with drill-down into individual session details.

## Success Criteria

- Admin dashboard loads in <2s with aggregate stats for 1000+ users
- Subdomain routing resolves `username.8gent.app` to the correct tenant context
- Billing pipeline tracks daily token usage and enforces plan limits
- All admin endpoints require authentication + admin role verification

## Dependencies

- Phase 2 (Auth + Convex DB) — provides Clerk auth, user/session/usage tables
- Convex for real-time data queries
- Clerk for authentication and role management
- Stripe for billing (integration stubs, full implementation in Phase 6)

## Out of Scope (Phase 5)

- Full Stripe payment processing (stubs only)
- Custom domain support (only `*.8gent.app`)
- Multi-region deployment
- Rate limiting at the edge
