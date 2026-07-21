import { useEffect, useMemo, useState } from 'react';
import api from '../../api/axios';

/**
 * AsyncMultiSelect
 * ------------------------------------------------------------------
 * Generic multi-select combobox that loads its option catalogue from
 * a REST endpoint once on mount.  Selected ids are stored as strings
 * to keep JSX diff-friendly; the parent converts to ObjectId strings
 * when POST/PATCH-ing.
 */
function AsyncMultiSelect({ endpoint, mapOption, value = [], onChange, placeholder, disabled }) {
  const [options, setOptions] = useState([]);
  const [q, setQ] = useState('');
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.get(endpoint)
      .then(({ data }) => {
        if (!alive) return;
        const list = Array.isArray(data) ? data : (data && data.rows) || [];
        setOptions(list.map(mapOption).filter((o) => o && o.value));
      })
      .catch((e) => { if (alive) setErr(e.message || 'load failed'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [endpoint]);

  const selectedSet = useMemo(() => new Set(value.map(String)), [value]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((o) => o.label.toLowerCase().includes(needle));
  }, [options, q]);
  const selectedList = options.filter((o) => selectedSet.has(String(o.value)));

  const toggle = (id) => {
    const s = new Set(value.map(String));
    if (s.has(String(id))) s.delete(String(id));
    else s.add(String(id));
    onChange(Array.from(s));
  };

  return (
    <div className={`border rounded-md p-2 space-y-2 bg-white ${disabled ? 'opacity-60 pointer-events-none' : ''}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="search"
          placeholder={placeholder || 'Search…'}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="flex-1 min-w-[10rem] border rounded-md text-sm px-2 py-1"
        />
        <span className="text-xs text-slate-500 shrink-0">{selectedList.length} selected</span>
      </div>
      {selectedList.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selectedList.map((o) => (
            <span key={o.value} className="text-[11px] bg-brand-50 text-brand-700 px-2 py-0.5 rounded-full flex items-center gap-1">
              {o.label}
              <button
                type="button"
                onClick={() => toggle(o.value)}
                className="text-brand-500 hover:text-brand-700"
                aria-label={`Remove ${o.label}`}
              >×</button>
            </span>
          ))}
        </div>
      )}
      <div className="border rounded-md max-h-40 overflow-y-auto bg-slate-50">
        {loading && <div className="p-2 text-xs text-slate-500">Loading…</div>}
        {err && <div className="p-2 text-xs text-red-600">Load failed: {err}</div>}
        {!loading && !err && filtered.length === 0 && (
          <div className="p-2 text-xs text-slate-500">No matches.</div>
        )}
        {!loading && filtered.slice(0, 200).map((o) => {
          const checked = selectedSet.has(String(o.value));
          return (
            <label
              key={o.value}
              className={`flex items-center gap-2 text-xs px-2 py-1 cursor-pointer ${checked ? 'bg-brand-50' : 'hover:bg-white'}`}
            >
              <input type="checkbox" checked={checked} onChange={() => toggle(o.value)} />
              <span className="flex-1 truncate">{o.label}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/**
 * RuleScopePicker -- four AsyncMultiSelects driving `rule.scope`.
 *
 * Scope semantics (mirrors backend/services/compliance/scope.js):
 *   - EMPTY at every field  -> rule applies to every active
 *                              non-super-admin, non-auto_attendance employee.
 *   - ANY field populated   -> UNION of the populated cohorts.
 *
 * A short "predicted cohort" line is rendered as a UX hint; the
 * actual detection cohort is computed by the backend on the next
 * tick (a preview endpoint is a Phase-2 concern).
 */
export default function RuleScopePicker({ value = {}, onChange }) {
  const scope = value || {};
  const patch = (k, next) => onChange({ ...scope, [k]: next });
  const _isEmpty = ['departments', 'designations', 'templates', 'employeeIds'].every(
    (k) => !Array.isArray(scope[k]) || scope[k].length === 0,
  );
  return (
    <div className="space-y-4">
      <div className={`text-xs rounded-md px-3 py-2 border ${_isEmpty ? 'bg-amber-50 text-amber-800 border-amber-200' : 'bg-slate-50 text-slate-600'}`}>
        {_isEmpty
          ? 'No scope constraints — the rule will apply to every active employee (excluding super admins and auto-attendance staff).'
          : 'Scope resolves to the UNION of the populated fields below.'}
      </div>

      <FieldGroup title="Departments" subtitle="Restrict to employees in the selected departments.">
        <AsyncMultiSelect
          endpoint="/departments"
          mapOption={(d) => ({ value: d._id, label: d.name || d.title || d._id })}
          value={scope.departments || []}
          onChange={(v) => patch('departments', v)}
          placeholder="Search departments…"
        />
      </FieldGroup>

      <FieldGroup title="Designations" subtitle="Restrict to specific designations.">
        <AsyncMultiSelect
          endpoint="/designations"
          mapOption={(d) => ({ value: d._id, label: d.title || d.name || d._id })}
          value={scope.designations || []}
          onChange={(v) => patch('designations', v)}
          placeholder="Search designations…"
        />
      </FieldGroup>

      <FieldGroup title="Templates" subtitle="For template-scoped rules only (e.g. missed submission for a specific template).">
        <AsyncMultiSelect
          endpoint="/templates"
          mapOption={(t) => ({ value: t._id, label: `${t.title || t._id}${t.templateType ? ` · ${t.templateType}` : ''}` })}
          value={scope.templates || []}
          onChange={(v) => patch('templates', v)}
          placeholder="Search templates…"
        />
      </FieldGroup>

      <FieldGroup title="Specific employees" subtitle="Include named employees (added to the union above).">
        <AsyncMultiSelect
          endpoint="/employees"
          mapOption={(e) => ({ value: e._id, label: `${e.name || e.employeeId || e._id}${e.employeeId ? ` (${e.employeeId})` : ''}` })}
          value={scope.employeeIds || []}
          onChange={(v) => patch('employeeIds', v)}
          placeholder="Search employees…"
        />
      </FieldGroup>
    </div>
  );
}

function FieldGroup({ title, subtitle, children }) {
  return (
    <div>
      <div className="text-sm font-semibold text-slate-800">{title}</div>
      {subtitle && <div className="text-xs text-slate-500 mb-1">{subtitle}</div>}
      {children}
    </div>
  );
}
