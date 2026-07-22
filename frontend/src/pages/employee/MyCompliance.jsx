import { useEffect, useMemo, useState } from 'react';
import api from '../../api/axios';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import ActionBadge from '../../components/compliance/ActionBadge.jsx';
import WaiverRequestModal from './WaiverRequestModal.jsx';
import { fmtDate, errMsg } from '../../utils/helpers';
import { useToast } from '../../context/ToastContext.jsx';
import IncidentDetailPanel from '../hr/compliance/IncidentDetailPanel.jsx';

/**
 * My Compliance -- employee's personal compliance workspace.
 * Three tabs:
 *   - Timeline (ComplianceEvent stream)
 *   - Incidents (grouped list + drill-in)
 *   - Ledgers (marks / financial / percentage / attendance)
 */
export default function MyCompliance() {
  const [tab, setTab] = useState('timeline');
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">My Compliance</h1>
        <p className="text-sm text-slate-500">
          Everything on your compliance record — rules that fired, actions applied, and their audit trail.
        </p>
      </div>
      <div className="flex items-center gap-2 border-b border-slate-200">
        {['timeline', 'incidents', 'ledgers'].map((k) => (
          <button
            key={k}
            className={`px-4 py-2 text-sm capitalize border-b-2 -mb-px ${tab === k ? 'border-brand-500 text-brand-700 font-semibold' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
            onClick={() => setTab(k)}
          >
            {k}
          </button>
        ))}
      </div>
      {tab === 'timeline'  && <TimelineTab />}
      {tab === 'incidents' && <IncidentsTab />}
      {tab === 'ledgers'   && <LedgersTab />}
    </div>
  );
}

// -----------------------------------------------------------
// Timeline
// -----------------------------------------------------------
function TimelineTab() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    api.get('/compliance/timeline/me', { params: { limit: 200 } })
      .then(({ data }) => setRows(data))
      .catch((e) => setErr(errMsg(e)));
  }, []);
  if (err) return <div className="text-sm text-red-600">Timeline load failed: {err}</div>;
  if (!rows) return <Loader />;
  if (rows.length === 0) return <EmptyState title="Empty timeline" subtitle="Nothing has fired on your record yet." />;
  return (
    <ol className="space-y-2">
      {rows.map((ev) => (
        <li key={ev._id} className="border rounded-md p-3 bg-white">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-xs text-slate-500">{new Date(ev.ts).toLocaleString()}</div>
            <div className="text-[11px] uppercase font-semibold text-slate-500">{ev.kind.replace(/_/g, ' ')}</div>
          </div>
          {ev.payload && Object.keys(ev.payload).length > 0 && (
            <pre className="mt-2 text-[11px] text-slate-600 bg-slate-50 border rounded p-2 overflow-x-auto">
              {JSON.stringify(ev.payload, null, 2)}
            </pre>
          )}
        </li>
      ))}
    </ol>
  );
}

// -----------------------------------------------------------
// Incidents
// -----------------------------------------------------------
function IncidentsTab() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [waiverFor, setWaiverFor] = useState(null);
  const toast = useToast();

  const load = () => {
    api.get('/compliance/incidents', { params: { limit: 200 } })
      .then(({ data }) => setRows(data))
      .catch((e) => setErr(errMsg(e)));
  };
  useEffect(load, []);

  const openIncident = async (inc) => {
    try {
      const { data } = await api.get(`/compliance/incidents/${inc._id}`);
      setOpenId(data);
    } catch (e) { toast.error(errMsg(e)); }
  };

  if (err)  return <div className="text-sm text-red-600">Incident load failed: {err}</div>;
  if (!rows) return <Loader />;
  if (rows.length === 0) return <EmptyState title="No incidents" subtitle="Your record is clean." />;

  return (
    <div className="grid md:grid-cols-3 gap-4">
      <div className="md:col-span-1 space-y-2">
        {rows.map((inc) => (
          <button key={inc._id}
            className={`w-full text-left border rounded-md p-3 hover:bg-slate-50 ${openId && openId.incident._id === inc._id ? 'ring-2 ring-brand-500' : ''}`}
            onClick={() => openIncident(inc)}
          >
            <div className="text-sm font-medium">{inc.ruleCode.replace(/_/g, ' ')}</div>
            <div className="text-xs text-slate-500">
              {fmtDate(inc.incidentDate)} · <span className="capitalize">{inc.status}</span>
            </div>
          </button>
        ))}
      </div>
      <div className="md:col-span-2">
        <IncidentDetailPanel
          data={openId}
          viewer="employee"
          onWaive={() => setWaiverFor({ incident: openId.incident, effects: openId.effects })}
          onReload={() => openIncident(openId.incident)}
        />
      </div>
      <WaiverRequestModal
        open={!!waiverFor}
        incident={waiverFor?.incident}
        effects={waiverFor?.effects}
        onClose={() => setWaiverFor(null)}
        onSubmitted={() => { toast.success('Waiver request sent.'); load(); }}
      />
    </div>
  );
}

function IncidentDetail({ data, onWaive, onReload }) {
  const { incident, effects, waivers } = data;
  const canWaive = ['candidate', 'active'].includes(incident.status);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="text-lg font-semibold">{incident.ruleCode.replace(/_/g, ' ')}</div>
          <div className="text-xs text-slate-500">
            {fmtDate(incident.incidentDate)} → effective {fmtDate(incident.effectiveDate)}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs px-2 py-0.5 rounded border bg-slate-50 capitalize">{incident.status}</span>
          {canWaive && <button className="btn-secondary !py-1 !text-xs" onClick={onWaive}>Request Waiver</button>}
        </div>
      </div>
      <div>
        <div className="text-xs uppercase font-semibold text-slate-500 mb-1">Actions applied</div>
        {effects.length === 0 ? (
          <div className="text-xs text-slate-500">No actions applied yet.</div>
        ) : (
          <div className="flex flex-wrap gap-1">
            {effects.map((e) => <ActionBadge key={e._id} effect={e} />)}
          </div>
        )}
      </div>
      {waivers && waivers.length > 0 && (
        <div>
          <div className="text-xs uppercase font-semibold text-slate-500 mb-1">Waiver history</div>
          <ul className="space-y-1">
            {waivers.map((w) => (
              <li key={w._id} className="border rounded-md p-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="capitalize">{w.status}</span>
                  <span className="text-slate-500">{new Date(w.requestedAt).toLocaleString()}</span>
                </div>
                {w.reason && <div className="text-slate-700 mt-0.5">Reason: {w.reason}</div>}
                {w.decisionNote && <div className="text-slate-500 mt-0.5">HR note: {w.decisionNote}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <button className="text-xs text-brand-600" onClick={onReload}>Refresh</button>
    </div>
  );
}

// -----------------------------------------------------------
// Ledgers
// -----------------------------------------------------------
function LedgersTab() {
  const [ledger, setLedger] = useState('financial');
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        {['marks', 'financial', 'percentage', 'attendance'].map((l) => (
          <button key={l}
            onClick={() => setLedger(l)}
            className={`px-3 py-1 rounded-md text-xs capitalize border ${ledger === l ? 'bg-brand-500 text-white border-brand-500' : 'bg-white text-slate-700 border-slate-200'}`}
          >
            {l}
          </button>
        ))}
      </div>
      <LedgerView ledger={ledger} />
    </div>
  );
}

function LedgerView({ ledger }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    setRows(null); setErr(null);
    api.get(`/compliance/ledgers/${ledger}`)
      .then(({ data }) => setRows(data))
      .catch((e) => {
        // Phase 6 only shipped read endpoints via timelineService for
        // events; ledger read endpoints are Phase 8.  Show a friendly
        // placeholder until those land.
        if (e.response?.status === 404) setRows([]);
        else setErr(errMsg(e));
      });
  }, [ledger]);

  const total = useMemo(() => {
    if (!rows || rows.length === 0) return 0;
    return rows[rows.length - 1].runningBalance;
  }, [rows]);

  if (err) return <div className="text-sm text-red-600">Ledger load failed: {err}</div>;
  if (!rows) return <Loader />;
  if (rows.length === 0) return <EmptyState title="No ledger entries" subtitle={`Your ${ledger} ledger is empty.`} />;
  return (
    <div>
      <div className="text-xs text-slate-500 mb-2">
        Current balance: <span className="font-semibold text-slate-700">{total}</span>
      </div>
      <table className="w-full text-xs border rounded-md overflow-hidden">
        <thead className="bg-slate-50">
          <tr>
            <th className="text-left px-2 py-1.5">Date</th>
            <th className="text-left px-2 py-1.5">Type</th>
            <th className="text-right px-2 py-1.5">Change</th>
            <th className="text-right px-2 py-1.5">Balance</th>
            <th className="text-left px-2 py-1.5">Reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r._id} className="border-t border-slate-100">
              <td className="px-2 py-1.5">{fmtDate(r.date)}</td>
              <td className="px-2 py-1.5 capitalize">{r.type}</td>
              <td className={`px-2 py-1.5 text-right font-medium ${r.direction === -1 ? 'text-red-600' : 'text-green-600'}`}>
                {r.direction === -1 ? '−' : '+'}{r.quantity}
              </td>
              <td className="px-2 py-1.5 text-right">{r.runningBalance}</td>
              <td className="px-2 py-1.5 text-slate-500">{r.reason || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
