# Phase 5: Control Plane & Tenant Isolation — PRD

## Overview

The control plane is the admin/monitoring layer for 8gent's multi-tenant platform. It provides visibility into platform health, user management, and billing infrastructure.

---

## Requirements

### P0 — Admin Dashboard

| Requirement | Description |
|-------------|-------------|
| Stats Overview | Total users, active sessions, tokens consumed today, estimated revenue |
| User List | Paginated, searchable list of all users with plan, last active, total usage |
| Session Monitor | Recent sessions across all users with model, duration, token counts |
| Usage Charts | Line chart of daily token usage (last 30 days), model distribution pie chart |
| Auth Guard | All dashboard routes require Clerk auth + admin role |

### P1 — Subdomain Routing & Tenant Isolation

| Requirement | Description |
|-------------|-------------|
| Subdomain Mapping | `username.8gent.app` resolves to the user's tenant context |
| Tenant Config | Each tenant has: subdomain, plan, usage limits, feature flags |
| Tenant CRUD | Create, read, update, delete tenant configurations |
| Usage Enforcement | Check token usage against plan limits before allowing new sessions |

### P2 — Billing Infrastructure

| Requirement | Description |
|-------------|-------------|
| Plan Definitions | Free (10K tokens/day), Pro ($29/mo, unlimited), Team ($99/mo, multi-user) |
| Usage Metering | Daily token aggregation per tenant for billing purposes |
| Stripe Stubs | Customer creation, subscription management, webhook handler (stubs) |
| Invoice Preview | Show estimated charges based on current usage |

---

## User Stories

1. As an **admin**, I want to see a real-time dashboard of platform activity so I can monitor health.
2. As an **admin**, I want to search and manage users so I can handle support requests.
3. As an **admin**, I want to view per-user usage charts so I can identify power users and abuse.
4. As an **admin**, I want to upgrade/downgrade user plans so I can manage subscriptions.
5. As a **user**, I want my 8gent instance at `myname.8gent.app` so I have a branded URL.
6. As a **user**, I want to see my usage against my plan limits so I know when to upgrade.

---

## Non-Functional Requirements

- Dashboard page load: <2s for up to 10K users
- Real-time session count updates via Convex subscriptions
- Admin role enforced at middleware level (not just UI)
- All Convex admin queries use server-side auth checks
- Responsive layout (desktop primary, tablet secondary)
