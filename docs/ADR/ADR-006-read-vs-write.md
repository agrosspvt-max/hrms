# ADR-006 — Move `runDaily` out of GET; introduce `POST /compliance/refresh`

## Problem
`GET /api/submissions/today` ran `penaltyEngine.runDaily`. Every dashboard reload, SSE-driven refetch, and React StrictMode double-mount re-invoked the write path. This was the load-bearing violation of the read/write rule.

## Alternatives considered
1. Keep the lazy trigger in GET but add strict idempotency downstream.
2. Move the engine entirely to the scheduler.
3. Move the engine to the scheduler AND expose an explicit action endpoint for client-initiated re-scans.

## Chosen
Option 3.  `submissionController.getToday` no longer calls the engine.  `POST /api/compliance/refresh` runs `runDaily` for the caller (or a specified employee when the caller is HR); `POST /api/compliance/refresh/all` runs the org-wide sweep (HR/SA only).  The daily scheduler is unchanged.

## Advantages
- GET is truly a read.
- Employees can still trigger a re-scan explicitly (button) without violating the discipline.
- Reversible: turning the scheduler off just delays the sweep; nothing crashes.

## Trade-offs
- Employees who used to see the newest penalty on their dashboard *immediately* after refresh now wait for either the scheduler or the button. Acceptable — the scheduler runs on boot and daily.

## Future migration path
The pattern (GET reads, POST for actions) becomes the project-wide rule. Phase 2 adds an ESLint rule that flags any write from a GET handler.
