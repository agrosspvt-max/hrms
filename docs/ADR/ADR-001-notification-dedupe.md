# ADR-001 — Keep Notification, add dedupe fields + partial unique index

## Problem
`Notification.insertMany` with no dedupe key caused the "8 notifications for 2 penalties" incident. Fixing the callers alone is fragile — a future caller can regress the same bug.

## Alternatives considered
1. Introduce a new `DomainEvent` collection and derive notifications from it.
2. Add a dedupe key + partial unique index to the existing collection.
3. Route every notification through a message queue with idempotency keys.

## Chosen
Option 2. `Notification` gains `eventKey`, `sourceRef`, `variant`, `archivedAt`; partial unique index `(recipient, eventKey, variant)` where `eventKey` is a non-empty string.

## Advantages
- Zero migration: legacy rows have `eventKey: ''` and stay out of the index.
- Works even when callers misfire: the DB collapses duplicates.
- No new collection, no new infrastructure.
- Every future caller inherits the guarantee for free by writing through `_upsertOne`.

## Trade-offs
- Callers must supply a stable, natural `eventKey` per business event.
- Callers migrating from `insertMany` to `_upsertOne` need small edits.

## Future migration path
When we ever adopt a full domain-event ledger, `_upsertOne` becomes a projector subscribed to the ledger. Nothing else changes.
