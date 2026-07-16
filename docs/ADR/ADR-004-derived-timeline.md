# ADR-004 — Derived timeline (live union), not materialised

## Problem
Employees and HR need a chronological "what happened for this employee" view. A dedicated `TimelineEntry` collection would require every writer to shadow-write a timeline row and every historical migration to backfill.

## Alternatives considered
1. Dedicated `TimelineEntry` collection with projectors.
2. Live union query over `Submission`, `Penalty`, `Leave`, `SalarySlip`, `Interaction`, `AttendanceConfirmation`.
3. Cache derived timeline per employee.

## Chosen
Option 2, shipped in Phase 2 behind `services/timeline.js`. Backend normalises each row to `{occurredAt, type, title, summary, sourceRef, actorRef}` and merges.

## Advantages
- No new collection, no drift, no backfill.
- Cheap at our scale.
- The source entity is the source of truth; edits/deletes remain honest.

## Trade-offs
- Adding a new module means editing the timeline service.

## Future migration path
Wrap the union query behind `services/timeline.js`. If it ever gets slow, swap the implementation for a materialised projection subscribed to `events.publish`. No caller changes.
