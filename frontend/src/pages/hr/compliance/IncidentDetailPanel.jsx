import { useEffect, useMemo, useState } from 'react';
import api from '../../../api/axios';
import { Loader } from '../../../components/Loader.jsx';
import ActionBadge from '../../../components/compliance/ActionBadge.jsx';
import { errMsg, fmtDate } from '../../../utils/helpers';
import {
  ruleTitle, detectorLabel, actionMeta, effectValue, ledgerRefLabel,
  eventPresentation, severityTone, statusTone, fmtWhen, isOpenIncident,
} from '../../../utils/incidentPresenter.js';

/**
 * IncidentDetailPanel -- audit-report view of a single ComplianceIncident.
 *
 * Reused by BOTH:
 *   - HR   : ComplianceWorkspace -> Incidents tab -> right pane
 *   - EMP  : MyCompliance         -> Incidents tab -> right pane
 *
 * The `viewer` prop toggles HR-only sections (natural key, actor
 * details, incident id, escalation memo).  Business behaviour is
 * unchanged; this component only READS existing endpoints:
 *
 *   GET /api/compliance/incidents/:id          (already loaded by callers)
 *   GET /api/compliance/timeline/incident/:id  (existing, previously unused)
 *   GET /api/compliance/rules/:id              (existing, called only to
 *                                                render the Rule Snapshot
 *                                                and Recovery Policy)
 *
 * Props:
 *   data     -- { incident, effects, waivers } from GET /incidents/:id
 *   viewer   -- 'hr' | 'employee'
 *   busy     -- disable action buttons while a parent write is in flight
 *   onWaive  -- (incident) => void   HR + Employee (opens waiver modal)
 *   onRecover-- (incident) => void   HR only
 *   onCancel -- (incident) => void   HR only
 *   onReload -- () => void           called after a successful mutation
 */
export default function IncidentDetailPanel({
  data, viewer = 'hr', busy = false,
  onWaive, onRecover, onCancel, onReload,
  onDecideWaiver,   // HR-only: (waiverId, decision) => void
}) {
  const { incident, effects, waivers } = data || {};
  const isHR = viewer === 'hr';

  // Timeline is loaded independently so a slow GET doesn't block the
  // primary detail render.
  const [events, setEvents] = useState(null);
  const [eventsErr, setEventsErr] = useState(null);
  useEffect(() => {
    if (!incident || !incident._id) return;
    let alive = true;
    setEvents(null); setEventsErr(null);
    api.get(`/compliance/timeline/incident/${incident._id}`, { params: { limit: 200 } })
      .then(({ data }) => { if (alive) setEvents(Array.isArray(data) ? data : []); })
      .catch((e) => { if (alive) setEventsErr(errMsg(e)); });
    return () => { alive = false; };
  }, [incident?._id]);

  // Rule snapshot -- we render both the incident's snapshot version
  // AND the current rule config.  ComplianceIncident does not store
  // the historical rule body, so the "configured actions / evaluation
  // delay / escalation" panel shows the CURRENT rule and warns when
  // the current version is newer than the incident's version.
  const [rule, setRule] = useState(null);
  useEffect(() => {
    if (!incident || !incident.ruleId) return;
    let alive = true;
    api.get(`/compliance/rules/${incident.ruleId}`)
      .then(({ data }) => { if (alive) setRule(data); })
      .catch(() => { /* rule may be deleted; hide the snapshot section */ });
    return () => { alive = false; };
  }, [incident?.ruleId]);

  if (!incident) return <div className="text-sm text-slate-500 border rounded-md p-6 bg-slate-50">Select an incident to view details.</div>;

  return (
    <div className="space-y-4">
      <EmployeeIdentityCard incident={incident} />
      <SummaryCard incident={incident} isHR={isHR}
        onWaive={onWaive} onRecover={onRecover} onCancel={onCancel} busy={busy} onReload={onReload} />
      <WhyCard incident={incident} />
      <WorkContextCard incident={incident} />
      <ActionsAppliedCard effects={effects} />
      <LedgerStatusCard effects={effects} />
      <TimelineCard events={events} err={eventsErr} />
      <RecoveryCard waivers={waivers} incident={incident} rule={rule}
        onDecideWaiver={onDecideWaiver} busy={busy} />
      <RuleSnapshotCard incident={incident} rule={rule} />
      {isHR && <HrDetailsCard incident={incident} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Section 0 -- Employee identity                                       */
/*                                                                      */
/* Renders whose incident this is.  The incident-detail endpoint now    */
/* populates `employee` with { _id, name, employeeId, department.name,  */
/* designation.title } so the panel doesn't need a second round-trip.   */
/* When populate misses (deleted user account) we degrade to the raw id.*/
/* ------------------------------------------------------------------ */
function EmployeeIdentityCard({ incident }) {
  const emp = incident && incident.employee;
  const populated = emp && typeof emp === 'object';
  const name = populated ? (emp.name || 'Employee') : null;
  const empId = populated ? emp.employeeId : null;
  const dept = populated && emp.department && emp.department.name;
  const desig = populated && emp.designation && emp.designation.title;
  const initials = (n = '?') =>
    n.trim().split(/\s+/).slice(0, 2).map((w) => (w[0] || '')).join('').toUpperCase() || '?';
  return (
    <div className="border rounded-lg bg-white p-4 flex items-center gap-3 flex-wrap">
      <div className="w-11 h-11 rounded-full bg-brand-50 text-brand-700 grid place-items-center font-semibold shrink-0">
        {name ? initials(name) : '?'}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] uppercase text-slate-500 font-semibold">Employee</div>
        <div className="text-base font-semibold text-slate-900 truncate">
          {name || (
            <span className="text-slate-500 italic">
              Employee account no longer exists · <code className="text-[11px]">{String(emp || '').slice(-8)}</code>
            </span>
          )}
        </div>
        <div className="text-xs text-slate-500 mt-0.5 flex flex-wrap gap-x-3">
          {empId && <span>ID: <span className="font-medium text-slate-700">{empId}</span></span>}
          {dept  && <span>Dept: <span className="text-slate-700">{dept}</span></span>}
          {desig && <span>Designation: <span className="text-slate-700">{desig}</span></span>}
          {!empId && !dept && !desig && populated && (
            <span className="italic">No directory details on record.</span>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Section 1 -- Summary                                                */
/* ------------------------------------------------------------------ */
function SummaryCard({ incident, isHR, onWaive, onRecover, onCancel, busy, onReload }) {
  const canAct = isOpenIncident(incident.status);
  const sourceLabel = incident.source === 'manual' ? 'Manual (HR-initiated)' : 'Automatic (scheduler)';
  return (
    <div className="border rounded-lg bg-white p-4 space-y-3">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="text-[11px] uppercase text-slate-500 font-semibold">Rule</div>
          <h2 className="text-xl font-semibold text-slate-900">{ruleTitle(incident.ruleCode)}</h2>
          <div className="text-xs text-slate-500 mt-0.5">
            <code>{incident.ruleCode}</code> · v{incident.ruleVersion}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${statusTone(incident.status)} capitalize`}>
            {incident.status}
          </span>
          {incident.severity && (
            <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${severityTone(incident.severity)} capitalize`}>
              {incident.severity}
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <Meta label="Source" value={sourceLabel} />
        <Meta label="Incident date" value={fmtWhen(incident.incidentDate, false)} />
        <Meta label="Effective date" value={fmtWhen(incident.effectiveDate, false)} />
        <Meta label="Current phase" value={<PhaseChip status={incident.status} />} />
      </div>

      {canAct && (onWaive || onRecover || onCancel) && (
        <div className="flex items-center justify-end gap-2 pt-1 border-t border-slate-100">
          {onWaive   && <button className="btn-secondary !py-1 !text-xs" disabled={busy} onClick={() => onWaive(incident)}>Request waiver</button>}
          {onRecover && <button className="btn-secondary !py-1 !text-xs" disabled={busy} onClick={() => onRecover(incident)}>Recover</button>}
          {onCancel  && <button className="btn-secondary !py-1 !text-xs text-red-600" disabled={busy} onClick={() => onCancel(incident)}>Cancel incident</button>}
          {onReload  && <button className="text-xs text-brand-600 ml-2" onClick={onReload}>Refresh</button>}
        </div>
      )}
    </div>
  );
}
function PhaseChip({ status }) {
  const phases = ['candidate', 'active', 'resolved'];
  return (
    <div className="flex items-center gap-1 text-[11px]">
      {phases.map((p, i) => (
        <span key={p} className="flex items-center gap-1">
          <span className={`px-1.5 py-0.5 rounded ${status === p ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-500'}`}>
            {p}
          </span>
          {i < phases.length - 1 && <span className="text-slate-300">→</span>}
        </span>
      ))}
      {['waived', 'cancelled', 'expired'].includes(status) && (
        <span className="ml-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 capitalize">{status}</span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Section 2 -- Why this happened                                       */
/* ------------------------------------------------------------------ */
function WhyCard({ incident }) {
  const meta = incident.detectorMeta || {};
  const ctx = incident.context || {};
  const reason = meta.reason;
  const detector = detectorLabel(meta.detector) || (incident.source === 'manual' ? 'HR-initiated' : '—');
  const hrOverride = meta.hrOverride;

  const rows = [];
  if (reason)          rows.push(['Reason',   <span key="r" className="whitespace-pre-wrap">{reason}</span>]);
  if (detector)        rows.push(['Detector', detector]);
  rows.push(['Source', incident.source === 'manual' ? 'Manual (HR-initiated)' : 'Automatic (scheduler)']);
  if (ctx.workDate)    rows.push(['Work date', fmtWhen(ctx.workDate, false)]);
  if (ctx.scheduleLabel) rows.push(['Schedule', ctx.scheduleLabel]);
  if (ctx.templateTitle) rows.push(['Template', ctx.templateTitle]);
  if (meta.templateType) rows.push(['Template type', String(meta.templateType).replace(/\b\w/g, (c) => c.toUpperCase())]);
  if (meta.criticalTask) rows.push(['Critical task?', 'Yes']);
  if (hrOverride) {
    const parts = [];
    if (hrOverride.marks   != null) parts.push(`Marks: ${hrOverride.marks}`);
    if (hrOverride.amount  != null) parts.push(`Amount: ₹${hrOverride.amount}`);
    if (hrOverride.percent != null) parts.push(`Percent: ${hrOverride.percent}%`);
    if (parts.length) rows.push(['HR-supplied value', parts.join(' · ')]);
  }

  if (rows.length === 0) return null;
  return (
    <Card title="Why this happened">
      <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-2">
            <dt className="text-slate-500 min-w-[8rem]">{k}</dt>
            <dd className="text-slate-800">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Section 3 -- Work Context                                            */
/* ------------------------------------------------------------------ */
function WorkContextCard({ incident }) {
  const ctx = incident.context || {};
  const meta = incident.detectorMeta || {};

  const rows = [];
  if (ctx.templateTitle)  rows.push(['Template', ctx.templateTitle]);
  if (ctx.assignmentId)   rows.push(['Assignment ID', <code key="a" className="text-[11px]">{String(ctx.assignmentId).slice(-8)}</code>]);
  if (ctx.submissionId)   rows.push(['Submission ID', <code key="s" className="text-[11px]">{String(ctx.submissionId).slice(-8)}</code>]);
  if (ctx.taskTitle)      rows.push(['Task', ctx.taskTitle]);
  if (ctx.taskId)         rows.push(['Task ID', <code key="ti" className="text-[11px]">{String(ctx.taskId).slice(-8)}</code>]);
  if (ctx.departmentId)   rows.push(['Department ID', <code key="d" className="text-[11px]">{String(ctx.departmentId).slice(-8)}</code>]);
  if (ctx.designationId)  rows.push(['Designation ID', <code key="dg" className="text-[11px]">{String(ctx.designationId).slice(-8)}</code>]);
  if (Array.isArray(ctx.dependencyIds) && ctx.dependencyIds.length > 0) {
    rows.push(['Dependencies', `${ctx.dependencyIds.length} open at trigger time`]);
  }
  if (meta.overdueCount)  rows.push(['Overdue tasks', meta.overdueCount]);
  if (meta.oldest && meta.oldest.taskTitle) {
    rows.push(['Oldest overdue', `${meta.oldest.taskTitle}${meta.oldest.pendingSince ? ` · pending since ${fmtWhen(meta.oldest.pendingSince, false)}` : ''}`]);
  }

  if (rows.length === 0) return null;
  return (
    <Card title="Work context" subtitle="Only fields present on this incident are shown.">
      <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-2">
            <dt className="text-slate-500 min-w-[8rem]">{k}</dt>
            <dd className="text-slate-800 min-w-0 break-words">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Section 4 -- Actions Applied                                         */
/* ------------------------------------------------------------------ */
function ActionsAppliedCard({ effects }) {
  const list = Array.isArray(effects) ? effects : [];
  return (
    <Card title="Actions applied" count={list.length}>
      {list.length === 0 ? (
        <EmptyLine>No actions have been applied yet — the incident is either still a candidate or the action engine has not run for this rule.</EmptyLine>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1">
            {list.map((e) => <ActionBadge key={e._id} effect={e} />)}
          </div>
          <ul className="space-y-1 pt-1 border-t border-slate-100">
            {list.map((e) => {
              const meta = actionMeta(e.actionType);
              const val = effectValue(e);
              const statusTag =
                e.status === 'waived'    ? <em className="text-amber-700 not-italic ml-1">(waived)</em> :
                e.status === 'resolved'  ? <em className="text-emerald-700 not-italic ml-1">(resolved)</em> :
                e.status === 'cancelled' ? <em className="text-slate-500 not-italic ml-1">(cancelled)</em> :
                e.status === 'pending'   ? <em className="text-slate-500 not-italic ml-1">(pending)</em> :
                null;
              return (
                <li key={e._id} className="text-sm text-slate-800 flex gap-2 items-baseline">
                  <span className="text-green-600">✓</span>
                  <span>
                    {meta.verb}
                    {val && <span className="text-slate-500 ml-1">{val}</span>}
                    {statusTag}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Section 5 -- Ledger Status                                           */
/* ------------------------------------------------------------------ */
function LedgerStatusCard({ effects }) {
  const list = Array.isArray(effects) ? effects : [];
  if (list.length === 0) {
    return (
      <Card title="Ledger status">
        <EmptyLine>No ledger writes are expected until actions have been applied.</EmptyLine>
      </Card>
    );
  }
  return (
    <Card title="Ledger status" subtitle="Which ledgers this specific incident wrote to.">
      <ul className="divide-y">
        {list.map((e) => {
          const meta = actionMeta(e.actionType);
          const family = meta.ledger;
          const refs = e.ledgerRefs || {};
          const refId = family ? refs[family] : null;
          let status, tone, sub;
          if (!family) {
            status = 'No ledger entry required';
            tone = 'text-slate-500';
            sub = 'This action type does not affect employee ledgers.';
          } else if (refId) {
            status = `✓ Written to ${prettyLedger(family)}`;
            tone = 'text-emerald-700';
            sub = `Reference: ${ledgerRefLabel(family, refId)}`;
          } else {
            status = 'Skipped';
            tone = 'text-amber-700';
            sub = 'Quantity resolved to zero, so no ledger row was created.';
          }
          return (
            <li key={e._id} className="py-2 flex items-start gap-3 text-sm">
              <div className="min-w-[10rem] shrink-0">
                <div className="font-medium text-slate-800">{meta.verb}</div>
                <div className="text-[11px] text-slate-500">{prettyLedger(family) || 'Notification / signal'}</div>
              </div>
              <div className="flex-1">
                <div className={`font-medium ${tone}`}>{status}</div>
                <div className="text-[11px] text-slate-500 mt-0.5">{sub}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
const prettyLedger = (f) => ({
  marks: 'Marks Ledger', financial: 'Financial Ledger',
  percentage: 'Percentage Ledger', attendance: 'Attendance Ledger',
}[f] || null);

/* ------------------------------------------------------------------ */
/* Section 6 -- Timeline                                                */
/* ------------------------------------------------------------------ */
function TimelineCard({ events, err }) {
  return (
    <Card title="Timeline">
      {err && <div className="text-sm text-red-600 border rounded-md p-2 bg-red-50">{err}</div>}
      {!err && !events && <Loader />}
      {events && events.length === 0 && <EmptyLine>No timeline events recorded yet.</EmptyLine>}
      {events && events.length > 0 && (
        <ol className="relative border-l-2 border-slate-200 ml-2 space-y-3">
          {events.slice().reverse().map((ev) => {
            const p = eventPresentation(ev.kind);
            return (
              <li key={ev._id} className="pl-4 -ml-[9px]">
                <span className="absolute -translate-x-1/2 mt-0.5 w-4 h-4 rounded-full bg-white border-2 border-slate-300 grid place-items-center text-[10px]">
                  {p.icon}
                </span>
                <div className={`text-sm font-medium ${p.tone}`}>{p.label}</div>
                <div className="text-[11px] text-slate-500">{fmtWhen(ev.ts)}</div>
                {ev.payload && ev.payload.reason && (
                  <div className="text-[12px] text-slate-600 mt-0.5">Reason: {ev.payload.reason}</div>
                )}
                {ev.payload && ev.payload.actionType && (
                  <div className="text-[12px] text-slate-600 mt-0.5">{actionMeta(ev.payload.actionType).verb}</div>
                )}
                {ev.payload && ev.payload.mode && (
                  <div className="text-[12px] text-slate-600 mt-0.5">Mode: {String(ev.payload.mode)}</div>
                )}
                {ev.payload && ev.payload.decision && (
                  <div className="text-[12px] text-slate-600 mt-0.5">Decision: {String(ev.payload.decision).replace(/_/g, ' ')}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Section 7 -- Recovery                                                */
/* ------------------------------------------------------------------ */
function RecoveryCard({ waivers, incident, rule, onDecideWaiver, busy }) {
  const list = Array.isArray(waivers) ? waivers : [];
  const policy = rule && rule.recovery;
  const anyClosureSignal = list.length > 0 || incident.resolvedAt || incident.cancelledAt || incident.waivedAt;
  const policyRelevant = !!policy;
  if (!anyClosureSignal && !policyRelevant) return null;

  return (
    <Card title="Recovery &amp; waivers">
      {policyRelevant && (
        <div className="text-xs text-slate-600 mb-2">
          <span className="font-semibold">Policy: </span>
          {policy.allowed !== false ? 'recovery allowed' : 'recovery NOT allowed'}
          {policy.autoResolveOnSubmit && <span> · auto-resolves on submit</span>}
          {policy.autoResolveOnResolve && <span> · auto-resolves on dependency close</span>}
          {policy.requiredEvidence && <span> · evidence required</span>}
          {Array.isArray(policy.modes) && policy.modes.length > 0 && (
            <span> · modes: {policy.modes.join(', ')}</span>
          )}
        </div>
      )}

      {incident.resolvedAt && (
        <div className="text-sm border rounded-md p-2 bg-emerald-50 mb-2">
          <div className="text-emerald-800 font-medium">Resolved</div>
          <div className="text-[11px] text-emerald-700">on {fmtWhen(incident.resolvedAt)}</div>
        </div>
      )}
      {incident.waivedAt && (
        <div className="text-sm border rounded-md p-2 bg-amber-50 mb-2">
          <div className="text-amber-800 font-medium">Waived</div>
          <div className="text-[11px] text-amber-700">on {fmtWhen(incident.waivedAt)}</div>
        </div>
      )}
      {incident.cancelledAt && (
        <div className="text-sm border rounded-md p-2 bg-slate-100 mb-2">
          <div className="text-slate-800 font-medium">Cancelled</div>
          <div className="text-[11px] text-slate-600">
            {incident.cancelReason ? `Reason: ${incident.cancelReason}` : ''} on {fmtWhen(incident.cancelledAt)}
          </div>
        </div>
      )}

      {list.length === 0 ? (
        <EmptyLine>No waiver requests on this incident yet.</EmptyLine>
      ) : (
        <ul className="space-y-2">
          {list.map((w) => (
            <li key={w._id} className="border rounded-md p-2 text-sm">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <span className={`text-[11px] px-2 py-0.5 rounded-full capitalize ${w.status === 'approved' || w.status === 'auto_approved' ? 'bg-emerald-100 text-emerald-800' : w.status === 'rejected' ? 'bg-red-100 text-red-800' : 'bg-slate-100 text-slate-700'}`}>
                    {w.status.replace(/_/g, ' ')}
                  </span>
                  <span className="text-[11px] text-slate-500 ml-2">
                    requested {fmtWhen(w.requestedAt)}
                    {w.decidedAt ? ` · decided ${fmtWhen(w.decidedAt)}` : ''}
                  </span>
                </div>
                <span className="text-[11px] text-slate-500">Scope: {w.scope}</span>
              </div>
              {w.reason && <div className="text-slate-700 text-[12px] mt-1">Reason: {w.reason}</div>}
              {w.decisionNote && <div className="text-slate-500 text-[12px] mt-1">HR note: {w.decisionNote}</div>}
              {w.evidenceUrl && (
                <div className="text-[11px] mt-1">
                  <a className="text-brand-600 hover:underline" href={w.evidenceUrl} target="_blank" rel="noreferrer">Evidence</a>
                </div>
              )}
              {w.status === 'pending' && onDecideWaiver && (
                <div className="mt-2 flex items-center gap-2">
                  <button className="btn-primary !py-1 !text-xs" disabled={busy}
                    onClick={() => onDecideWaiver(w._id, 'approved')}>Approve</button>
                  <button className="btn-ghost !py-1 !text-xs text-red-600" disabled={busy}
                    onClick={() => onDecideWaiver(w._id, 'rejected')}>Reject</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Section 8 -- Rule Snapshot                                           */
/* ------------------------------------------------------------------ */
function RuleSnapshotCard({ incident, rule }) {
  if (!rule) {
    return (
      <Card title="Rule snapshot" subtitle="Historical rule body isn't stored; showing what we know.">
        <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <Row k="Rule code" v={<code>{incident.ruleCode}</code>} />
          <Row k="Rule version at trigger" v={`v${incident.ruleVersion}`} />
          <Row k="Detector" v={detectorLabel((incident.detectorMeta || {}).detector) || '—'} />
        </dl>
      </Card>
    );
  }
  const drift = rule.version !== incident.ruleVersion;
  const configuredActions = (rule.actions || []);
  return (
    <Card
      title="Rule snapshot"
      subtitle={drift
        ? `Historical rule body isn't stored. Rule was v${incident.ruleVersion} when fired; current is v${rule.version}.`
        : `Rule body has not changed since this incident (v${rule.version}).`}
    >
      <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <Row k="Rule code" v={<code>{incident.ruleCode}</code>} />
        <Row k="Version"   v={`v${incident.ruleVersion}${drift ? ` (current v${rule.version})` : ''}`} />
        <Row k="Category"  v={<span className="capitalize">{rule.category}</span>} />
        <Row k="Detector"  v={detectorLabel(rule.detector)} />
        <Row k="Evaluation delay" v={`${(rule.trigger && rule.trigger.evaluationDelayDays) || 0} day(s)`} />
        {rule.trigger && rule.trigger.thresholdDays > 0 && <Row k="Threshold" v={`${rule.trigger.thresholdDays} day(s)`} />}
      </dl>
      <div className="mt-3">
        <div className="text-[11px] uppercase text-slate-500 font-semibold mb-1">
          Configured actions ({configuredActions.length})
        </div>
        {configuredActions.length === 0 ? (
          <EmptyLine>No actions configured on the current rule.</EmptyLine>
        ) : (
          <ul className="text-sm text-slate-700 space-y-1">
            {configuredActions.map((a) => {
              const meta = actionMeta(a.type);
              const cfg = a.config || {};
              const bits = [];
              if (cfg.marks     != null) bits.push(`marks: ${cfg.marks}`);
              if (cfg.amount    != null) bits.push(`₹${cfg.amount}`);
              if (cfg.criticalAmount != null) bits.push(`critical ₹${cfg.criticalAmount}`);
              if (cfg.percent   != null) bits.push(`${cfg.percent}%`);
              if (cfg.percentPerDay != null) bits.push(`${cfg.percentPerDay}%/day`);
              if (cfg.maxCap    != null) bits.push(`cap ${cfg.maxCap}`);
              if (cfg.recurring)         bits.push('recurring');
              return (
                <li key={a._id || a.type} className="flex gap-2">
                  <span className={a.enabled === false ? 'text-slate-400' : 'text-slate-700'}>
                    {a.enabled === false ? '○' : '●'}
                  </span>
                  <span className="flex-1">
                    {meta.verb}
                    {bits.length > 0 && <span className="text-slate-500 text-[12px] ml-1">({bits.join(', ')})</span>}
                    {a.enabled === false && <span className="text-[11px] text-slate-400 ml-1">disabled</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {Array.isArray(rule.escalation) && rule.escalation.length > 0 && (
        <div className="mt-3">
          <div className="text-[11px] uppercase text-slate-500 font-semibold mb-1">Escalation</div>
          <EscalationSummary
            steps={rule.escalation}
            fired={(incident.detectorMeta && incident.detectorMeta.escalatedStepIds) || []}
          />
        </div>
      )}
    </Card>
  );
}
function EscalationSummary({ steps, fired }) {
  const firedSet = new Set(fired.map(String));
  return (
    <ol className="text-sm text-slate-700 space-y-1">
      {steps.map((s, i) => {
        const done = firedSet.has(String(s._id));
        return (
          <li key={s._id || i} className="flex items-baseline gap-2">
            <span className={done ? 'text-emerald-600' : 'text-slate-400'}>{done ? '✓' : '○'}</span>
            <span>
              After {s.afterDays} day(s)
              {Array.isArray(s.actionsAdd) && s.actionsAdd.length > 0 && (
                <span className="text-slate-500 text-[12px] ml-1">
                  — adds: {s.actionsAdd.map((a) => actionMeta(a.type).verb).join(', ')}
                </span>
              )}
              {done && <span className="text-[11px] text-emerald-700 ml-1">(fired)</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ */
/* HR-only fields                                                       */
/* ------------------------------------------------------------------ */
function HrDetailsCard({ incident }) {
  const meta = incident.detectorMeta || {};
  const cb = incident.createdBy;
  return (
    <Card title="HR details">
      <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <Row k="Incident ID"  v={<code className="text-[11px]">{String(incident._id)}</code>} />
        <Row k="Created"      v={fmtWhen(incident.createdAt)} />
        {cb && typeof cb === 'object' && (cb.name || cb.email) && (
          <Row k="Created by" v={<>
            {cb.name || cb.email}
            {cb.name && cb.email ? <span className="text-slate-400"> · {cb.email}</span> : null}
          </>} />
        )}
        <Row k="Source"       v={incident.source === 'manual' ? 'Manual' : 'Automatic'} />
        <Row k="Detector"     v={detectorLabel(meta.detector) || '—'} />
        <Row k="Natural key"  v={<code className="text-[11px] break-all">{incident.naturalKey}</code>} />
        {meta.source === 'attendance_flip' && (
          <Row k="Manual source" v="Attendance flip (Absent → Present with Performance Penalty)" />
        )}
        {Array.isArray(meta.escalatedStepIds) && meta.escalatedStepIds.length > 0 && (
          <Row k="Escalation" v={`${meta.escalatedStepIds.length} step(s) fired`} />
        )}
      </dl>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Shared primitives                                                    */
/* ------------------------------------------------------------------ */
function Card({ title, subtitle, count, children }) {
  return (
    <section className="border rounded-lg bg-white p-4 space-y-3">
      <header>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
          {count != null && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">{count}</span>
          )}
        </div>
        {subtitle && <p className="text-[11px] text-slate-500 mt-0.5">{subtitle}</p>}
      </header>
      <div>{children}</div>
    </section>
  );
}
function Row({ k, v }) {
  if (v == null || v === '') return null;
  return (
    <div className="flex gap-2">
      <dt className="text-slate-500 min-w-[9rem]">{k}</dt>
      <dd className="text-slate-800 min-w-0 break-words">{v}</dd>
    </div>
  );
}
function Meta({ label, value }) {
  return (
    <div>
      <div className="text-[11px] uppercase text-slate-500 font-semibold">{label}</div>
      <div className="text-sm text-slate-800">{value}</div>
    </div>
  );
}
function EmptyLine({ children }) {
  return <div className="text-sm text-slate-500 italic">{children}</div>;
}
