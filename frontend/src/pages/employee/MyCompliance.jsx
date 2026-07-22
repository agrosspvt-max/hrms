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
/**
 * LedgersTab -- shows the employee's own ledger balances.
 *
 * Fix for the "incident says written, ledger tab empty" inconsistency:
 *   1. Fetches all four ledgers on mount so we can show counts on
 *      each sub-tab AND auto-select the first non-empty one.
 *   2. Renders a real error message when the endpoint returns 404
 *      (previously silently rendered empty state, which was
 *      indistinguishable from a genuinely empty ledger and the
 *      #1 reason users thought "no data" when the flag was off).
 *   3. Passes the loaded rows down so LedgerView doesn't refetch.
 */
const LEDGER_KINDS = ['marks', 'financial', 'percentage', 'attendance'];
const LEDGER_LABEL = {
  marks: 'Marks', financial: 'Financial', percentage: 'Percentage', attendance: 'Attendance',
};

function LedgersTab() {
  const [ledger, setLedger] = useState(null);   // resolved after preload
  const [byKind, setByKind] = useState(null);   // { marks: [...], financial: [...], ... }
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    setByKind(null); setErr(null);
    Promise.all(LEDGER_KINDS.map((k) =>
      api.get(`/compliance/ledgers/${k}`)
        .then(({ data }) => [k, data || []])
        .catch((e) => {
          if (e.response?.status === 404) {
            throw new Error(
              'Compliance ledgers are not enabled on this deployment (COMPLIANCE_WAIVER_RECOVERY off).'
            );
          }
          throw new Error(errMsg(e));
        })
    ))
      .then((entries) => {
        if (!alive) return;
        const map = Object.fromEntries(entries);
        setByKind(map);
        // Smart default: prefer the first ledger that actually has data.
        // Falls back to 'financial' when all four are empty.
        const firstNonEmpty = LEDGER_KINDS.find((k) => (map[k] || []).length > 0);
        setLedger(firstNonEmpty || 'financial');
      })
      .catch((e) => { if (alive) setErr(e.message || String(e)); });
    return () => { alive = false; };
  }, []);

  if (err) return <div className="text-sm text-red-600 border rounded-md p-3 bg-red-50">Ledger load failed: {err}</div>;
  if (!byKind) return <Loader />;

  const rowsForKind = (k) => (byKind[k] || []);
  const totalRows = LEDGER_KINDS.reduce((s, k) => s + rowsForKind(k).length, 0);

  return (
    <div>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        {LEDGER_KINDS.map((l) => {
          const count = rowsForKind(l).length;
          const active = ledger === l;
          return (
            <button key={l}
              onClick={() => setLedger(l)}
              className={`px-3 py-1 rounded-md text-xs capitalize border flex items-center gap-1.5 ${active ? 'bg-brand-500 text-white border-brand-500' : 'bg-white text-slate-700 border-slate-200'}`}
            >
              {LEDGER_LABEL[l]}
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${active ? 'bg-white/25 text-white' : 'bg-slate-100 text-slate-700'}`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>
      {totalRows === 0 ? (
        <EmptyState
          title="No ledger entries yet"
          subtitle="Ledger rows appear only after an incident's actions actually write to a ledger (notifications, warnings and performance-lock actions never do)."
        />
      ) : (
        <LedgerView rows={rowsForKind(ledger)} ledger={ledger} byKind={byKind} onJump={setLedger} />
      )}
    </div>
  );
}

function LedgerView({ rows, ledger, byKind, onJump }) {
  const total = rows.length ? rows[rows.length - 1].runningBalance : 0;
  if (rows.length === 0) {
    // The current sub-tab is empty, but other sub-tabs have data.
    // Point the user at the ones that do.
    const others = LEDGER_KINDS
      .filter((k) => k !== ledger && (byKind[k] || []).length > 0);
    return (
      <div className="border rounded-md p-4 bg-white space-y-2">
        <div className="text-sm font-medium text-slate-800">
          No entries in {LEDGER_LABEL[ledger]} Ledger.
        </div>
        <div className="text-xs text-slate-500">
          This ledger has never been written to for your account. The action types that write to it may not be part of the rules that fired on your record.
        </div>
        {others.length > 0 && (
          <div className="text-xs text-slate-600 pt-1">
            You do have entries in:&nbsp;
            {others.map((k, i) => (
              <span key={k}>
                <button className="text-brand-600 hover:underline" onClick={() => onJump(k)}>
                  {LEDGER_LABEL[k]} ({byKind[k].length})
                </button>
                {i < others.length - 1 ? ', ' : ''}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }
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
