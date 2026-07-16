# ADR-005 — `Reminder` is the only new collection

## Problem
"Please submit today's work", "Meeting starts in 15 minutes", "Complete profile" are conceptually different from notifications: they can repeat, they self-clear when done, and they need cadence + snooze + completedAt.

## Alternatives considered
1. Reuse `Notification` with a `channel: 'reminder'` flag.
2. New `Reminder` collection with its own lifecycle.
3. Compute reminders on the fly from source state.

## Chosen
Option 2, shipped in Phase 2. `Reminder { subject, actionKind, dueAt, cadence, snoozeUntil, completedAt, dismissedAt, hash }`. Partial unique index on `{hash}` where `completedAt: null`.

## Advantages
- Reminders never pollute the Notification inbox counter.
- Repeat / snooze / dismiss / done live on the reminder, not the notification.
- Deterministic natural key means restarts / cron double-ticks never produce duplicates.

## Trade-offs
- One additional collection.
- Cadence scheduler needed (small — every 15 minutes).

## Future migration path
Reminder can be sharded / partitioned per-tenant later without any impact on the rest of the system.
