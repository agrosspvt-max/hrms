import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../api/axios';

/**
 * useDraftAutosave
 *
 * Sits next to the existing submit pipeline.  Given an unsubmitted
 * submission and a `buildPayload()` callback that produces the same
 * payload the submit endpoint accepts, this hook persists drafts to
 * `PUT /api/submissions/:id/draft`:
 *
 *   - Periodic flush every `intervalMs` (default 30s) when dirty.
 *   - Debounced flush `debounceMs` (default 1500ms) after the most
 *     recent input change so a user pause triggers a quiet save.
 *   - `beforeunload` sendBeacon so a refresh or tab close still
 *     captures the in-flight changes (best-effort, may not include
 *     auth depending on the browser; the periodic + debounced flushes
 *     are the primary safety net).
 *   - Snapshot-based dirty tracking: the hook stringifies the
 *     payload and only flushes when it differs from the last saved
 *     snapshot.  Idempotent against repeated input churn that
 *     happens to produce the same payload (e.g. typing then deleting).
 *   - In-flight coalescing: if a save is in flight when new dirt
 *     arrives, the hook re-flushes once the in-flight save resolves.
 *
 * Returns a small state object the form can render as a status pill:
 *
 *   { status, savedAt, saveNow, markDirty }
 *
 *   status   : 'idle' | 'dirty' | 'saving' | 'saved' | 'error'
 *   savedAt  : Date | null     -- last successful save timestamp
 *   saveNow  : ()=>Promise     -- manual "Save Draft" handler
 *   markDirty: ()=>void        -- call from input handlers; the hook
 *                                also auto-detects dirt every render,
 *                                this is just a low-latency hint.
 *
 * Disable by passing `enabled: false` (e.g. when the submission is
 * already submitted -- no draft path applies).
 */
export default function useDraftAutosave({
  submissionId,
  buildPayload,
  initialSavedAt = null,
  enabled = true,
  intervalMs = 30000,
  debounceMs = 1500,
}) {
  const [status, setStatus] = useState('idle');
  const [savedAt, setSavedAt] = useState(initialSavedAt ? new Date(initialSavedAt) : null);
  const lastSnapshotRef = useRef('');
  const inFlightRef = useRef(false);
  const dirtyAfterFlushRef = useRef(false);
  const debounceTimerRef = useRef(null);
  const buildPayloadRef = useRef(buildPayload);
  buildPayloadRef.current = buildPayload;

  const flush = useCallback(async () => {
    if (!enabled || !submissionId) return;
    if (inFlightRef.current) { dirtyAfterFlushRef.current = true; return; }
    let payload;
    try { payload = buildPayloadRef.current(); }
    catch (_e) { return; }
    const snapshot = JSON.stringify(payload);
    if (snapshot === lastSnapshotRef.current) {
      // Nothing changed since the last successful save.
      setStatus((s) => (s === 'dirty' ? 'saved' : s));
      return;
    }
    inFlightRef.current = true;
    setStatus('saving');
    try {
      const { data } = await api.put(`/submissions/${submissionId}/draft`, payload);
      lastSnapshotRef.current = snapshot;
      setStatus('saved');
      setSavedAt(data?.lastDraftSavedAt ? new Date(data.lastDraftSavedAt) : new Date());
    } catch (_err) {
      setStatus('error');
    } finally {
      inFlightRef.current = false;
      if (dirtyAfterFlushRef.current) {
        dirtyAfterFlushRef.current = false;
        flush();
      }
    }
  }, [enabled, submissionId]);

  // Manual "Save Draft" button handler -- forces a flush even when
  // status thinks nothing changed.  Useful after explicit edits.
  const saveNow = useCallback(async () => {
    // Reset the snapshot so flush() doesn't short-circuit on a no-op.
    lastSnapshotRef.current = '';
    await flush();
  }, [flush]);

  // Low-latency dirt hint (called from form input handlers).  Also
  // schedules a debounced flush.
  const markDirty = useCallback(() => {
    if (!enabled) return;
    setStatus((s) => (s === 'saving' ? s : 'dirty'));
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => flush(), debounceMs);
  }, [enabled, flush, debounceMs]);

  // Periodic safety-net flush.
  useEffect(() => {
    if (!enabled) return undefined;
    const id = setInterval(() => flush(), intervalMs);
    return () => clearInterval(id);
  }, [enabled, flush, intervalMs]);

  // beforeunload: best-effort sendBeacon (no awaiting allowed).
  useEffect(() => {
    if (!enabled || !submissionId) return undefined;
    const handler = () => {
      try {
        const payload = buildPayloadRef.current();
        const snapshot = JSON.stringify(payload);
        if (snapshot === lastSnapshotRef.current) return;
        // sendBeacon doesn't carry our axios bearer header, so it's a
        // best-effort write -- mostly useful for cookie-auth deployments.
        // The periodic interval + debounce remain the primary safety net.
        const blob = new Blob([snapshot], { type: 'application/json' });
        navigator.sendBeacon?.(`/api/submissions/${submissionId}/draft`, blob);
      } catch (_e) { /* never block unload */ }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [enabled, submissionId]);

  // Clear any debounce on unmount.
  useEffect(() => () => { if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current); }, []);

  return { status, savedAt, saveNow, markDirty };
}
