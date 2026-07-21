import { useEffect, useMemo, useState } from 'react';
import api from '../../../api/axios';
import Modal from '../../../components/Modal.jsx';
import { Loader } from '../../../components/Loader.jsx';
import { useToast } from '../../../context/ToastContext.jsx';
import { errMsg } from '../../../utils/helpers';
import useComplianceRegistry from '../../../hooks/useComplianceRegistry.js';

/**
 * CreateIncidentModal
 * ------------------------------------------------------------------
 * Single reusable modal for the manual-incident workflow.
 *
 * Mounts from:
 *   - Compliance Workspace -> Incidents tab -> [+ New Incident]
 *   - EmployeeDetail -> Compliance Actions dropdown
 *
 * The form is dynamic: the visible fields change based on the picked
 * rule, so HR sees "Marks" for a marks rule, "Amount" for a financial
 * penalty rule, "Percentage" for a completion adjustment.  Backend
 * concepts (ruleCode, context, detectorMeta, naturalKey) are never
 * shown to HR -- they are populated on submit.
 *
 * Props:
 *   open            -- controls visibility.
 *   onClose         -- () => void; parent must clear its state.
 *   onCreated       -- (incident) => void; parent refreshes its list
 *                       and can auto-select the returned incident.
 *   presetEmployee  -- optional { _id, name, employeeId }; when
 *                       supplied the employee field is prefilled
 *                       and hidden (from EmployeeDetail entry point).
 *   presetRuleCode  -- optional string; picks the rule tab up front
 *                       (Employee Detail's shortcut buttons use this).
 *
 * Reuses:
 *   - components/Modal.jsx
 *   - context/ToastContext (useToast)
 *   - hooks/useComplianceRegistry (severities enum)
 *   - api/axios (single HTTP surface)
 */

// The four manual rules we surface.  Every entry maps the rule to
// the HR-facing "value" field the form should render.  If a new
// manual rule ships later, add a row here.
const MANUAL_RULE_MANIFEST = {
  attendance_manual_v2: {
    title: 'Attendance manual correction',
    valueField: { key: 'marks', label: 'Marks to deduct', unit: '', hint: 'Leave blank to use the rule default.' },
  },
  manual_marks_v2: {
    title: 'Manual marks adjustment',
    valueField: { key: 'marks', label: 'Marks to deduct', unit: '', hint: 'Leave blank to use the rule default.' },
  },
  completion_adjustment_v2: {
    title: 'Completion score adjustment',
    valueField: { key: 'percent', label: 'Percent to deduct', unit: '%', hint: 'Enter a value between 0 and 100.' },
  },
  financial_penalty_v2: {
    title: 'Financial penalty',
    valueField: { key: 'amount', label: 'Amount to charge', unit: '₹', hint: 'Leave blank to use the rule default.' },
  },
};

const _isoDay = (d) => new Date(d).toISOString().slice(0, 10);
const _today = () => _isoDay(new Date());

export default function CreateIncidentModal({
  open, onClose, onCreated,
  presetEmployee = null,
  presetRuleCode = null,
}) {
  const toast = useToast();
  const { severities: SEVERITIES } = useComplianceRegistry();

  // ---- form state -------------------------------------------------
  const [employee, setEmployee]       = useState(presetEmployee || null);
  const [ruleCode, setRuleCode]       = useState(presetRuleCode || '');
  const [workDate, setWorkDate]       = useState(_today());
  const [severity, setSeverity]       = useState('');
  const [valueInput, setValueInput]   = useState('');
  const [reason, setReason]           = useState('');
  const [submitting, setSubmitting]   = useState(false);

  // ---- catalogue: manual rules that are ENABLED -------------------
  const [rules, setRules] = useState(null);
  const [rulesErr, setRulesErr] = useState(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api.get('/compliance/rules')
      .then(({ data }) => {
        if (!alive) return;
        const manual = (data || []).filter(
          (r) => r.detector === 'manual' && r.enabled === true && MANUAL_RULE_MANIFEST[r.code],
        );
        setRules(manual);
      })
      .catch((e) => { if (alive) setRulesErr(errMsg(e)); });
    return () => { alive = false; };
  }, [open]);

  // ---- reset when modal reopens or presets change -----------------
  useEffect(() => {
    if (!open) return;
    setEmployee(presetEmployee || null);
    setRuleCode(presetRuleCode || '');
    setWorkDate(_today());
    setSeverity('');
    setValueInput('');
    setReason('');
    setSubmitting(false);
  }, [open, presetEmployee, presetRuleCode]);

  const rule = useMemo(
    () => (rules || []).find((r) => r.code === ruleCode) || null,
    [rules, ruleCode],
  );
  const manifest = ruleCode ? MANUAL_RULE_MANIFEST[ruleCode] : null;

  // Default severity to the rule's own severity the first time it is
  // picked; HR can override afterwards.
  useEffect(() => {
    if (rule && !severity) setSeverity(rule.severity || 'medium');
  }, [rule, severity]);

  // ---- validation ------------------------------------------------
  const errors = {};
  if (!employee || !employee._id) errors.employee = 'Pick an employee.';
  if (!ruleCode) errors.ruleCode = 'Pick an action.';
  if (!workDate) errors.workDate = 'Pick a work date.';
  if (!reason.trim()) errors.reason = 'Reason is required.';
  if (valueInput !== '') {
    const n = Number(valueInput);
    if (!Number.isFinite(n) || n < 0) errors.valueInput = 'Must be zero or a positive number.';
    if (manifest && manifest.valueField.key === 'percent' && n > 100) {
      errors.valueInput = 'Percent must be between 0 and 100.';
    }
  }
  const isValid = Object.keys(errors).length === 0;

  // ---- submit ----------------------------------------------------
  const onSubmit = async () => {
    if (!isValid || submitting) return;
    setSubmitting(true);
    try {
      // Compose the payload.  HR types business language; we map to
      // the backend shape here.  Every non-schema override lives on
      // detectorMeta.hrOverride so the executor can consult it.
      const overrides = {};
      if (valueInput !== '' && manifest) {
        overrides[manifest.valueField.key] = Number(valueInput);
      }
      const payload = {
        ruleCode,
        employee: employee._id,
        incidentDate: new Date(workDate).toISOString(),
        severity: severity || undefined,
        context: {
          workDate: new Date(workDate).toISOString(),
          departmentId: employee.department?._id || employee.department || null,
          designationId: employee.designation?._id || employee.designation || null,
        },
        detectorMeta: {
          source: 'hr_manual',
          reason: reason.trim(),
          ...(Object.keys(overrides).length ? { hrOverride: overrides } : {}),
        },
      };
      const { data } = await api.post('/compliance/incidents', payload);
      toast.success('Incident created.');
      onCreated && onCreated(data);
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={presetRuleCode && MANUAL_RULE_MANIFEST[presetRuleCode] ? MANUAL_RULE_MANIFEST[presetRuleCode].title : 'Create compliance incident'}
      size="lg"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
          <button type="button" className="btn-primary" onClick={onSubmit} disabled={!isValid || submitting}>
            {submitting ? 'Creating…' : 'Create incident'}
          </button>
        </>
      }
    >
      {rulesErr && (
        <div className="text-sm text-red-600 border rounded-md p-2 bg-red-50 mb-3">
          Could not load rules: {rulesErr}
        </div>
      )}
      {!rules && !rulesErr && <Loader />}
      {rules && rules.length === 0 && (
        <div className="text-sm text-slate-600 border rounded-md p-3 bg-slate-50">
          There are no manual compliance rules enabled. Ask a Super Admin to enable one of:
          <ul className="list-disc list-inside mt-1">
            <li>Attendance Manual Correction</li>
            <li>Manual Marks Adjustment</li>
            <li>Completion Score Adjustment</li>
            <li>Financial Penalty</li>
          </ul>
        </div>
      )}
      {rules && rules.length > 0 && (
        <div className="space-y-4">
          {/* Employee ---------------------------------------- */}
          <div>
            <Label>Employee</Label>
            {presetEmployee ? (
              <div className="border rounded-md px-3 py-2 text-sm bg-slate-50 text-slate-700">
                {presetEmployee.name}
                {presetEmployee.employeeId ? <span className="text-slate-500"> · {presetEmployee.employeeId}</span> : null}
              </div>
            ) : (
              <EmployeeSearchPicker value={employee} onChange={setEmployee} />
            )}
            <Err msg={errors.employee} />
          </div>

          {/* Rule --------------------------------------------- */}
          <div>
            <Label>Action</Label>
            <select
              value={ruleCode}
              onChange={(e) => { setRuleCode(e.target.value); setValueInput(''); setSeverity(''); }}
              className="w-full border rounded-md text-sm px-2 py-2"
            >
              <option value="">— pick an action —</option>
              {rules.map((r) => (
                <option key={r._id} value={r.code}>
                  {(MANUAL_RULE_MANIFEST[r.code] && MANUAL_RULE_MANIFEST[r.code].title) || r.name}
                </option>
              ))}
            </select>
            <Err msg={errors.ruleCode} />
          </div>

          {/* Dynamic value field + severity + date row -------- */}
          {rule && manifest && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <Label>{manifest.valueField.label}</Label>
                <div className="flex items-stretch border rounded-md overflow-hidden">
                  {manifest.valueField.unit && (
                    <span className="px-2 py-2 bg-slate-100 text-xs text-slate-600 flex items-center">
                      {manifest.valueField.unit}
                    </span>
                  )}
                  <input
                    type="number"
                    min={0}
                    step={manifest.valueField.key === 'percent' ? 0.5 : 1}
                    value={valueInput}
                    onChange={(e) => setValueInput(e.target.value)}
                    placeholder="Leave blank to use the rule default"
                    className="flex-1 border-0 outline-none text-sm px-2 py-2"
                  />
                </div>
                <div className="text-[11px] text-slate-500 mt-1">{manifest.valueField.hint}</div>
                <Err msg={errors.valueInput} />
              </div>
              <div>
                <Label>Work date</Label>
                <input
                  type="date"
                  value={workDate}
                  onChange={(e) => setWorkDate(e.target.value)}
                  className="w-full border rounded-md text-sm px-2 py-2"
                />
                <Err msg={errors.workDate} />
              </div>
              <div>
                <Label>Severity</Label>
                <select
                  value={severity}
                  onChange={(e) => setSeverity(e.target.value)}
                  className="w-full border rounded-md text-sm px-2 py-2"
                >
                  {SEVERITIES.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* Reason ------------------------------------------ */}
          {rule && (
            <div>
              <Label>Reason</Label>
              <textarea
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this being recorded? Visible in the audit trail."
                className="w-full border rounded-md text-sm px-2 py-2"
              />
              <Err msg={errors.reason} />
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

const Label = ({ children }) => (
  <span className="block text-[11px] uppercase text-slate-500 font-semibold mb-1">{children}</span>
);
const Err = ({ msg }) => (msg ? <div className="text-[11px] text-red-600 mt-1">{msg}</div> : null);

/**
 * EmployeeSearchPicker
 * -------------------------------------------------------------
 * Small single-select employee search built on the same
 * /employees endpoint the rest of the app uses.  Debounced remote
 * search so we never send a request per keystroke; renders a light
 * list underneath the box.  Chosen row displays as a chip that can
 * be cleared.
 */
function EmployeeSearchPicker({ value, onChange }) {
  const [q, setQ] = useState('');
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (value) return;               // hide list once someone is picked
    let alive = true;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const { data } = await api.get('/employees', { params: q ? { q } : {} });
        if (alive) setOptions(Array.isArray(data) ? data.slice(0, 25) : []);
      } catch (_) { if (alive) setOptions([]); }
      finally { if (alive) setLoading(false); }
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [q, value]);

  if (value) {
    return (
      <div className="flex items-center gap-2 border rounded-md px-3 py-2 bg-white">
        <span className="text-sm text-slate-800">
          {value.name}
          {value.employeeId ? <span className="text-slate-500"> · {value.employeeId}</span> : null}
        </span>
        <button
          type="button"
          className="ml-auto text-xs text-slate-500 hover:text-slate-800"
          onClick={() => onChange(null)}
        >
          Change
        </button>
      </div>
    );
  }
  return (
    <div className="border rounded-md bg-white overflow-hidden">
      <input
        type="search"
        autoFocus
        placeholder="Search by name, employee id, or email…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="w-full border-0 outline-none text-sm px-3 py-2"
      />
      {loading && <div className="text-xs text-slate-500 px-3 py-1">Searching…</div>}
      {!loading && options.length > 0 && (
        <ul className="max-h-52 overflow-y-auto border-t">
          {options.map((o) => (
            <li key={o._id}>
              <button
                type="button"
                className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50"
                onClick={() => onChange({
                  _id: o._id,
                  name: o.name,
                  employeeId: o.employeeId,
                  department: o.department,
                  designation: o.designation,
                })}
              >
                <div className="font-medium">{o.name}</div>
                <div className="text-xs text-slate-500">
                  {o.employeeId ? o.employeeId : ''}
                  {o.department && o.department.name ? ` · ${o.department.name}` : ''}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!loading && q && options.length === 0 && (
        <div className="text-xs text-slate-500 px-3 py-2">No matches.</div>
      )}
    </div>
  );
}
