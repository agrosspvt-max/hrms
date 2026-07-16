# ADR-003 — Derived dashboard alerts (live queries), not materialised

## Problem
Every dashboard card ("Active Penalties", "Pending Leave", "Upcoming Meetings") could be stored in a `DashboardAlert` collection kept in sync by projectors — or computed on demand.

## Alternatives considered
1. `DashboardAlert` collection with deterministic hash + projector on every domain event.
2. Live `countDocuments` / `findOne` per card at request time.
3. Cache derived counts in Redis with a short TTL.

## Chosen
Option 2. `GET /api/dashboard/alerts` runs a small `Promise.all` of counts across `Penalty`, `Leave`, `Interaction`, `Notification`, `Submission`.

## Advantages
- No new collection, no drift risk, no backfill.
- At tens–hundreds of employees, each query takes milliseconds.
- Every card's source of truth remains the entity itself.

## Trade-offs
- Every dashboard load runs a handful of counts. Cheap today; not free at very large scale.

## Future migration path
When queries hurt (tens of thousands of employees, millions of penalties), swap the count queries for a materialised projection behind the same endpoint. Callers never change.
