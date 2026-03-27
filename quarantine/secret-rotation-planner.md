# secret-rotation-planner

Plans and tracks secret rotation schedules with expiry alerts and rotation procedures.

## Requirements
- addSecret(planner, { name, type, lastRotated, rotationDays })
- dueForRotation(planner, now?): returns secrets past or within 7 days of expiry
- markRotated(planner, name, date?): updates last rotation timestamp
- procedure(secretType): returns step-by-step rotation guide for known types
- renderDashboard(planner): expiry timeline with urgency indicators

## Status

Quarantine - pending review.

## Location

`packages/tools/secret-rotation-planner.ts`
