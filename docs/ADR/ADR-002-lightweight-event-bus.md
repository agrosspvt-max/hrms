# ADR-002 — In-process EventEmitter, not a persisted event log

## Problem
We need one place to publish "penalty applied" so that Notification, Realtime, Timeline, Dashboard, and future Reminder subscribers all react. Building a full event-sourcing system now would be overkill.

## Alternatives considered
1. Persisted `DomainEvent` collection with projections.
2. External message queue (Redis Streams / SQS / Kafka).
3. In-process EventEmitter facade with a stable API.

## Chosen
Option 3, shipped in Phase 2. Callers use `events.publish('penalty.applied', ctx)`; subscribers register via `events.subscribe('penalty.applied', handler)`.

## Advantages
- ~120 lines, one file.
- No new collection, no cross-process queue.
- Publisher/subscriber contract identical to what a queue-based bus would expose, so migration is drop-in.

## Trade-offs
- Events are ephemeral. No replay, no analytics warehouse feed. Phase-3 concern only.
- Handlers run synchronously in the publisher's process; slow handlers can add latency to the write request. We move heavy handlers behind a queue when we ever have one.

## Future migration path
Swap `publish()` for a queue producer + persist to a `DomainEvent` collection. Subscribers become queue consumers. No caller changes.
