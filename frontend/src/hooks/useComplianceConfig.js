import { useEffect, useState } from 'react';
import api from '../api/axios';

/**
 * useComplianceConfig -- reads /api/compliance/config once per mount
 * and caches on window so multiple consumers on the same page share
 * a single request.
 */
let _cache = null;
let _inflight = null;

const loadOnce = () => {
  if (_cache) return Promise.resolve(_cache);
  if (_inflight) return _inflight;
  _inflight = api.get('/compliance/config')
    .then(({ data }) => { _cache = data; return data; })
    .catch(() => {
      // Fail closed -- treat every flag as off so a broken backend
      // never surfaces a half-built UI.
      _cache = {
        features: { employeeCardV2: false, dashboardV2: false, waiverRecovery: false, rules: false },
        rollout: {},
      };
      return _cache;
    })
    .finally(() => { _inflight = null; });
  return _inflight;
};

export default function useComplianceConfig() {
  const [cfg, setCfg] = useState(_cache);
  useEffect(() => {
    let cancelled = false;
    loadOnce().then((c) => { if (!cancelled) setCfg(c); });
    return () => { cancelled = true; };
  }, []);
  return cfg;
}

export const isFeatureEnabled = (cfg, key) =>
  !!(cfg && cfg.features && cfg.features[key]);
