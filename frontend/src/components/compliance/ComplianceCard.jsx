import { useEffect, useState } from 'react';
import api from '../../api/axios';
import { Loader } from '../Loader.jsx';
import ActionBadge from './ActionBadge.jsx';
import CountdownBadge from './CountdownBadge.jsx';
import WaiverRequestModal from '../../pages/employee/WaiverRequestModal.jsx';

/**
 * ComplianceCard -- employee dashboard card that replaces the legacy
 * PenaltyWarnings block.  Only renders when
 * `compliance.employeeCardV2` is on (the parent gates on that).
 *
 * Shows every active / candidate incident with:
 *   - Rule name + severity
 *   - Correction-window countdown for candidates
 *   - Per-action badges
 *   - "Request Waiver" button
 */
export default function ComplianceCard() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [waiverFor, setWaiverFor] = useState(null); // { incident, effects }

  const load = () => {
    setError(null);
    api.get('/compliance/incidents', { params: { status: 'active', limit: 20 } })
      .then(async ({ data }) => {
        const list = Array.isArray(data) ? data : [];
        // Second call to include candidates (no separate multi-status filter yet).
        const { data: cand } = await api.get('/compliance/incidents', { params: { status: 'candidate', limit: 10 } });
        setRows([...(cand || []), ...list]);
      })
      .catch((e) => setError(e.response?.data?.message || e.message));
  };

  useEffect(() => { load(); }, []);

  const openWaiver = async (incident) => {
    try {
      const { data } = await api.get(`/compliance/incidents/${incident._id}`);
      setWaiverFor({ incident: data.incident, effects: data.effects || [] });
    } catch (_) {
      setWaiverFor({ incident, effects: [] });
    }
  };

  if (rows === null) return <Loader label="Loading compliance…" />;
  if (error)         return <div className="text-xs text-red-600">Compliance load failed: {error}</div>;
  if (rows.length === 0) return null;   // nothing outstanding

  return (
    <div className="space-y-2">
      {rows.map((inc) => (
        <div key={inc._id} className={`border rounded-lg p-3 ${inc.status === 'candidate' ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200'}`}>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] uppercase tracking-wide font-semibold">
                  {inc.status === 'candidate' ? 'Upcoming' : 'Active'}
                </span>
                <span className="text-sm font-semibold">
                  {(inc.ruleCode || '').replace(/_/g, ' ')}
                </span>
                {inc.status === 'candidate' && <CountdownBadge effectiveDate={inc.effectiveDate} />}
                <IncidentEffectRow incidentId={inc._id} />
              </div>
              <div className="text-[11px] mt-1 opacity-80">
                For date: {new Date(inc.incidentDate).toLocaleDateString()}
                {inc.effectiveDate && ` · effective ${new Date(inc.effectiveDate).toLocaleDateString()}`}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <a href={`/my-compliance?incident=${inc._id}`} className="btn-ghost !py-1 !text-xs">Open</a>
              <button className="btn-secondary !py-1 !text-xs" onClick={() => openWaiver(inc)}>
                Request Waiver
              </button>
            </div>
          </div>
        </div>
      ))}
      <WaiverRequestModal
        open={!!waiverFor}
        incident={waiverFor?.incident}
        effects={waiverFor?.effects}
        onClose={() => setWaiverFor(null)}
        onSubmitted={load}
      />
    </div>
  );
}

function IncidentEffectRow({ incidentId }) {
  const [effs, setEffs] = useState(null);
  useEffect(() => {
    api.get(`/compliance/incidents/${incidentId}`)
      .then(({ data }) => setEffs(data.effects || []))
      .catch(() => setEffs([]));
  }, [incidentId]);
  if (!effs || effs.length === 0) return null;
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {effs.map((e) => <ActionBadge key={e._id} effect={e} />)}
    </div>
  );
}
