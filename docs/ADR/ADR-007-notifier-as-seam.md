# ADR-007 — Notification writer is the deduplication seam

## Problem
Even after fixing individual callers, any new caller could regress the "one event → many notifications" bug. Dedup needs a defence-in-depth layer.

## Alternatives considered
1. Trust every caller forever.
2. Enforce dedup at the notifier via upsert-by-`eventKey`.
3. Enforce dedup at the DB via unique index.

## Chosen
Both 2 and 3.  `services/notifyEvents._upsertOne` upserts on `(recipient, eventKey, variant)`, and the collection has a partial unique index on the same tuple.  A misfiring caller cannot produce a duplicate row even if the notifier code changes.

## Advantages
- Two independent layers of protection.
- Realtime frames only fire when a row is actually inserted (`upsertedCount === 1`), so the client never sees "notification:new" for a row that already existed.
- Every existing helper keeps its signature; only the internals change.

## Trade-offs
- Callers must supply a stable eventKey. Callers that don't (e.g. `leave.applied` sends one row per HR recipient today) are migrated opportunistically in Phase 2.

## Future migration path
When `services/events.js` lands in Phase 2, the notifier becomes a subscriber. Publishers no longer call `notify.*` directly — they publish domain events, and the notifier decides which recipient gets which variant. Dedup discipline stays at the notifier layer.
