import { useEffect, useState } from 'react';
import api from '../../../api/axios';
import { Loader, EmptyState } from '../../../components/Loader.jsx';
import { errMsg } from '../../../utils/helpers';

/**
 * RuleHistoryPanel
 * ------------------------------------------------------------------
 * Read-only right-side drawer that consumes the existing
 * GET /api/compliance/rules/:id/history endpoint.  Each row is an
 * AuditLog entry with `action` in {compliance.rule.create,
 * compliance.rule.update, compliance.rule.enable, compliance.rule.disable}.
 */
/**
 * QA-fix H1 -- render the populated actor.
 *
 * The backend now returns `actor` populated with `{_id, name, email}`
 * for these audit rows.  We prefer the name; if only an ObjectId
 * survived a race or the actor account was deleted we degrade
 * gracefully to "System" (for the sentinel system-actor ObjectId
 * used by automatic incident creations -- see incidentService.js)
 * or the raw actorRole.
 */
const SYSTEM_ACTOR_ID = '000000000000000000000000';
function ActorLabel({ actor, actorRole }) {
  if (!actor) return <span>{actorRole || 'system'}</span>;
  if (typeof actor === 'object') {
    const label = actor.name || actor.email;
    if (label) {
      return (
        <span>
          {actor.name || actor.email}
          {actor.name && actor.email ? <span className="text-slate-400"> · {actor.email}</span> : null}
        </span>
      );
    }
  }
  if (String(actor) === SYSTEM_ACTOR_ID) return <span>System</span>;
  return <span>{actorRole || 'user'}</span>;
}

const ACTION_LABEL = {
  'compliance.rule.create':  { label: 'Created',  tone: 'bg-green-100 text-green-800' },
  'compliance.rule.update':  { label: 'Updated',  tone: 'bg-blue-100 text-blue-800' },
  'compliance.rule.enable':  { label: 'Enabled',  tone: 'bg-emerald-100 text-emerald-800' },
  'compliance.rule.disable': { label: 'Disabled', tone: 'bg-slate-100 text-slate-700' },
};

export default function RuleHistoryPanel({ ruleId, ruleLabel, onClose }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let alive = true;
    api.get(`/compliance/rules/${ruleId}/history`)
      .then(({ data }) => { if (alive) setRows(data); })
      .catch((e) => { if (alive) setErr(errMsg(e)); });
    return () => { alive = false; };
  }, [ruleId]);

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <aside className="fixed top-0 right-0 h-full w-full sm:w-[420px] bg-white border-l shadow-xl z-50 overflow-y-auto">
        <header className="sticky top-0 bg-white border-b px-4 py-3 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs uppercase text-slate-500 font-semibold">History</div>
            <div className="text-sm font-semibold truncate">{ruleLabel || 'Rule'}</div>
          </div>
          <button type="button" className="btn-secondary !py-1 !text-xs" onClick={onClose}>Close</button>
        </header>

        <div className="p-3">
          {err && <div className="text-sm text-red-600 border rounded-md p-2 bg-red-50">{err}</div>}
          {!err && !rows && <Loader />}
          {rows && rows.length === 0 && <EmptyState title="No history yet" subtitle="This rule has not been modified since creation." />}
          {rows && rows.length > 0 && (
            <ol className="space-y-2">
              {rows.map((r) => {
                const meta = ACTION_LABEL[r.action] || { label: r.action, tone: 'bg-slate-100 text-slate-700' };
                const when = r.createdAt ? new Date(r.createdAt).toLocaleString() : '';
                const changed = (r.meta && Array.isArray(r.meta.changed)) ? r.meta.changed : null;
                return (
                  <li key={r._id} className="border rounded-md p-2 bg-white">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${meta.tone}`}>{meta.label}</span>
                      <span className="text-[11px] text-slate-500">{when}</span>
                    </div>
                    <div className="text-xs text-slate-600 mt-1">
                      by <ActorLabel actor={r.actor} actorRole={r.actorRole} />
                    </div>
                    {changed && changed.length > 0 && (
                      <div className="mt-1 text-[11px] text-slate-500">
                        Changed:&nbsp;
                        {changed.map((k) => (
                          <span key={k} className="inline-block mr-1 mb-1 bg-slate-100 text-slate-700 rounded px-1.5 py-0.5">
                            {k}
                          </span>
                        ))}
                      </div>
                    )}
                    {r.meta && r.meta.version != null && (
                      <div className="mt-1 text-[11px] text-slate-500">v{r.meta.version}</div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </aside>
    </>
  );
}
