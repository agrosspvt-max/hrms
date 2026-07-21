import useComplianceConfig from './useComplianceConfig.js';
import {
  CATEGORIES     as LOCAL_CATEGORIES,
  SEVERITIES     as LOCAL_SEVERITIES,
  DETECTORS      as LOCAL_DETECTORS,
  ACTION_TYPES   as LOCAL_ACTION_TYPES,
  MARKS_STRATEGIES as LOCAL_MARKS_STRATEGIES,
  RECOVERY_MODES as LOCAL_RECOVERY_MODES,
  APPROVER_ROLES as LOCAL_APPROVER_ROLES,
} from '../utils/complianceEnums.js';

/**
 * useComplianceRegistry
 * ------------------------------------------------------------------
 * QA-fix H4 -- exposes the merged enum registry.
 *
 * Preference order:
 *   1. Backend `/api/compliance/config` -> `.registry.*`  (source of truth)
 *   2. Local hardcoded fallback (this repo's complianceEnums.js)
 *
 * The local list carries display metadata (labels, hints,
 * per-action configSchema) that the backend does not know about.
 * When the backend advertises a value that the local list does not
 * know, we derive a minimal metadata object so unfamiliar values
 * still render.
 *
 * Backend list is authoritative for MEMBERSHIP; if the backend
 * removes an action type, we won't offer it in the builder even if
 * the local list still knows about it.  If the backend endpoint
 * fails (already handled by useComplianceConfig's fail-closed path)
 * we fall back to the full local list so HR is never left staring
 * at an empty dropdown.
 */

const _localMap = (list) => new Map(list.map((x) => [x.value, x]));
const _LOCAL_CATEGORY_MAP = _localMap(LOCAL_CATEGORIES);
const _LOCAL_SEVERITY_MAP = _localMap(LOCAL_SEVERITIES);
const _LOCAL_DETECTOR_MAP = _localMap(LOCAL_DETECTORS);
const _LOCAL_ACTION_MAP   = _localMap(LOCAL_ACTION_TYPES);
const _LOCAL_STRATEGY_MAP = _localMap(LOCAL_MARKS_STRATEGIES);
const _LOCAL_RECOVERY_MAP = _localMap(LOCAL_RECOVERY_MODES);
const _LOCAL_APPROVER_MAP = _localMap(LOCAL_APPROVER_ROLES);

// Backend sends string enums for most lists; detectors may already
// be objects (see configController._detectorList).  This normaliser
// accepts either shape.
const _normalise = (remote, localMap, localList, derive = null) => {
  if (!Array.isArray(remote) || remote.length === 0) return localList;
  return remote.map((entry) => {
    if (entry && typeof entry === 'object' && entry.value != null) {
      const localHit = localMap.get(entry.value);
      // Merge: local metadata (label/hint/tone/configSchema) with
      // remote authoritative fields (value + anything backend added).
      return { ...(localHit || {}), ...entry };
    }
    const value = String(entry);
    const localHit = localMap.get(value);
    if (localHit) return localHit;
    return derive ? derive(value) : { value, label: value };
  });
};

export default function useComplianceRegistry() {
  const cfg = useComplianceConfig();
  const remote = (cfg && cfg.registry) || {};
  return {
    categories:      _normalise(remote.categories,      _LOCAL_CATEGORY_MAP,  LOCAL_CATEGORIES),
    severities:      _normalise(remote.severities,      _LOCAL_SEVERITY_MAP,  LOCAL_SEVERITIES),
    detectors:       _normalise(remote.detectors,       _LOCAL_DETECTOR_MAP,  LOCAL_DETECTORS,
                        (v) => ({ value: v, label: v, automatic: false })),
    actionTypes:     _normalise(remote.actionTypes,     _LOCAL_ACTION_MAP,    LOCAL_ACTION_TYPES,
                        (v) => ({ value: v, label: v, hint: '', configSchema: [] })),
    marksStrategies: _normalise(remote.marksStrategies, _LOCAL_STRATEGY_MAP,  LOCAL_MARKS_STRATEGIES),
    recoveryModes:   _normalise(remote.recoveryModes,   _LOCAL_RECOVERY_MAP,  LOCAL_RECOVERY_MODES),
    approverRoles:   _normalise(remote.approverRoles,   _LOCAL_APPROVER_MAP,  LOCAL_APPROVER_ROLES),
    // Convenience -- looks up the merged action metadata by value.
    findActionSpec(value) {
      const list = _normalise(remote.actionTypes, _LOCAL_ACTION_MAP, LOCAL_ACTION_TYPES,
        (v) => ({ value: v, label: v, hint: '', configSchema: [] }));
      return list.find((a) => a.value === value) || null;
    },
    // Loading state -- true while the config request is in flight.
    loading: !cfg,
  };
}
