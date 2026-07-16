# Architecture Decision Records

Concise, one-page records of every material architecture decision in
the HRMS.  New ADRs are added as decisions land.

## Index

- [ADR-001 — Keep Notification, add dedupe fields + partial unique index](./ADR-001-notification-dedupe.md)
- [ADR-002 — In-process EventEmitter, not a persisted event log](./ADR-002-lightweight-event-bus.md)
- [ADR-003 — Derived dashboard alerts (live queries), not materialised](./ADR-003-derived-dashboard-alerts.md)
- [ADR-004 — Derived timeline (live union), not materialised](./ADR-004-derived-timeline.md)
- [ADR-005 — `Reminder` is the only new collection](./ADR-005-reminder-collection.md)
- [ADR-006 — Move `runDaily` out of GET; introduce `POST /compliance/refresh`](./ADR-006-read-vs-write.md)
- [ADR-007 — Notification writer is the deduplication seam](./ADR-007-notifier-as-seam.md)
