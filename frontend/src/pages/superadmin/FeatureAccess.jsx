import { useEffect, useMemo, useState } from 'react';
import api from '../../api/axios';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import SearchableSelect from '../../components/SearchableSelect.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg } from '../../utils/helpers';

/* =====================================================================
 * Phase 43 — Feature Access Management
 *
 * HR / Super Admin pick an employee, expand the card, and toggle which
 * modules they should see in their sidebar + access via the backend.
 *
 * The MODULE_CATALOG below drives the form -- adding a new module
 * means adding one entry here; no other code changes are needed.
 *
 * Module shape:
 *   { key, label, levels?, sub?, templateScoped?, perfSections? }
 *
 *   - key            : permissionMap.<key>.enabled flag
 *   - label          : human-readable label
 *   - levels         : ['view', 'edit', 'full'] -- radio group when present
 *   - sub            : { name: [actions[]], ... } -- per-action checkboxes
 *   - templateScoped : true -> render a Template Analytics scope picker
 *                      (server-loaded list)
 *   - perfSections   : array of Performance sub-toggles (calling /
 *                      productFarmer / dealer / dependency / templateAnalytics)
 * ===================================================================== */
const LEVEL_OPTIONS = [
  { value: 'view', label: 'View Only' },
  { value: 'edit', label: 'Edit' },
  { value: 'full', label: 'Full Access' },
];

const MODULE_CATALOG = [
  { key: 'dashboard',        label: 'Dashboard' },
  { key: 'attendance',       label: 'Attendance', levels: LEVEL_OPTIONS },
  { key: 'leaveApprovals',   label: 'Leave Approvals', levels: [
      { value: 'view', label: 'View Only' }, { value: 'full', label: 'Approve / Reject' },
    ] },
  { key: 'submissionReviews', label: 'Submission Reviews', levels: [
      { value: 'view', label: 'View Only' },
      { value: 'edit', label: 'Review' },
      { value: 'full', label: 'Assign Marks' },
    ] },
  { key: 'globalPendency',   label: 'Global Pendency' },
  { key: 'departments',      label: 'Departments', levels: LEVEL_OPTIONS },
  { key: 'products', label: 'Products & Dealers', sub: {
      products: ['view', 'create', 'edit', 'delete'],
      dealers:  ['view', 'create', 'edit', 'delete'],
    } },
  { key: 'assignments',       label: 'Assignments', levels: LEVEL_OPTIONS },
  { key: 'submissionControl', label: 'Submission Control', levels: LEVEL_OPTIONS },
  { key: 'templateAnalytics', label: 'Template Analytics', templateScoped: true },
  { key: 'salary', label: 'Salary', levels: [
      { value: 'view', label: 'View' },
      { value: 'edit', label: 'Generate' },
      { value: 'full', label: 'Full Control' },
    ] },
  { key: 'contacts',          label: 'Contacts', levels: LEVEL_OPTIONS },
  { key: 'eventsHolidays',    label: 'Events & Holidays', levels: LEVEL_OPTIONS },
  { key: 'auditLog',          label: 'Audit Log' },
  { key: 'sendAlerts',        label: 'Send Alerts' },
  { key: 'performance', label: 'Performance', perfSections: [
      { key: 'calling',          label: 'Calling Analytics' },
      { key: 'productFarmer',    label: 'Product & Farmer Report' },
      { key: 'dealer',           label: 'Dealer Analytics' },
      { key: 'dependency',       label: 'Dependency Analytics' },
      { key: 'templateAnalytics', label: 'Template Analytics' },
    ] },
];

export default function FeatureAccess() {
  const toast = useToast();
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [q, setQ]                 = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [openId, setOpenId]       = useState(null);
  const [departments, setDepartments] = useState([]);
  const [templates, setTemplates]     = useState([]);
  const [copyOpen, setCopyOpen]   = useState(null); // { targetId }

  const load = async () => {
    setLoading(true);
    try {
      const params = {};
      if (q.trim())          params.q = q.trim();
      if (departmentFilter)  params.department = departmentFilter;
      if (roleFilter)        params.role = roleFilter;
      const { data } = await api.get('/feature-permissions/employees', { params });
      setEmployees(data || []);
    } catch (err) { toast.error(errMsg(err)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [q, departmentFilter, roleFilter]);
  useEffect(() => {
    api.get('/departments').then((r) => setDepartments(r.data || [])).catch(() => {});
    api.get('/template-analytics').then((r) => setTemplates(r.data || [])).catch(() => {});
  }, []);

  const updateOne = (id, perms) => setEmployees((prev) =>
    prev.map((e) => (String(e._id) === String(id)
      ? { ...e, featurePermissions: perms, featurePermissionsUpdatedAt: new Date().toISOString() }
      : e))
  );

  const savePermissions = async (id, perms) => {
    try {
      await api.put(`/feature-permissions/${id}`, { featurePermissions: perms });
      updateOne(id, perms);
      toast.success('Permissions saved');
    } catch (err) { toast.error(errMsg(err)); }
  };

  const resetOne = async (id) => {
    if (!window.confirm('Reset all feature permissions for this employee?\nThe employee will revert to the default access for their role.')) return;
    try {
      await api.post(`/feature-permissions/${id}/reset`);
      updateOne(id, {});
      toast.success('Permissions reset to defaults');
    } catch (err) { toast.error(errMsg(err)); }
  };

  const copyFrom = async (targetId, sourceId) => {
    try {
      const { data } = await api.post(`/feature-permissions/${targetId}/copy-from/${sourceId}`);
      updateOne(targetId, data.featurePermissions || {});
      toast.success('Permissions copied');
      setCopyOpen(null);
    } catch (err) { toast.error(errMsg(err)); }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Feature Access</h1>
        <p className="text-sm text-slate-500">
          Grant specific HRMS modules to individual employees without promoting them to HR / Super Admin.
          Disabled modules disappear from the employee's sidebar and the backend rejects API calls to them.
        </p>
      </div>

      {/* Filters */}
      <div className="card card-body flex flex-wrap items-end gap-3">
        <input className="input max-w-[240px]" placeholder="Search name / ID / email"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="min-w-[200px]">
          <SearchableSelect
            value={departmentFilter}
            onChange={setDepartmentFilter}
            options={departments}
            getValue={(d) => d._id}
            getLabel={(d) => d.name}
            placeholder="All departments"
          />
        </div>
        <select className="input max-w-[160px]" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
          <option value="">All roles</option>
          <option value="employee">Employee</option>
          <option value="hr">HR</option>
          <option value="super_admin">Super Admin</option>
        </select>
      </div>

      {loading ? <Loader /> :
        employees.length === 0 ? <EmptyState title="No employees match these filters" /> :
        <div className="space-y-2">
          {employees.map((e) => (
            <EmployeeCard
              key={e._id}
              employee={e}
              open={openId === e._id}
              onToggle={() => setOpenId(openId === e._id ? null : e._id)}
              onSave={(perms) => savePermissions(e._id, perms)}
              onReset={() => resetOne(e._id)}
              onOpenCopy={() => setCopyOpen({ targetId: e._id, targetName: e.name })}
              templates={templates}
            />
          ))}
        </div>
      }

      {copyOpen && (
        <CopyPermissionsModal
          target={copyOpen}
          employees={employees}
          onClose={() => setCopyOpen(null)}
          onCopy={(sourceId) => copyFrom(copyOpen.targetId, sourceId)}
        />
      )}
    </div>
  );
}

/* ----------------- Per-employee collapsible card ----------------- */
function EmployeeCard({ employee, open, onToggle, onSave, onReset, onOpenCopy, templates }) {
  const [draft, setDraft] = useState(() => clone(employee.featurePermissions || {}));
  // Re-seed when the parent props change (e.g. after copy / reset).
  useEffect(() => { setDraft(clone(employee.featurePermissions || {})); }, [employee.featurePermissions]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(employee.featurePermissions || {});
  const enabledCount = MODULE_CATALOG.filter((m) => draft[m.key]?.enabled).length;

  const setModule = (key, patch) => setDraft((s) => {
    const cur = s[key] || {};
    return { ...s, [key]: { ...cur, ...patch } };
  });
  const setSub = (key, group, action, value) => setDraft((s) => {
    const cur = s[key] || {};
    const subCur = (cur.sub && cur.sub[group]) || {};
    return { ...s, [key]: { ...cur, sub: { ...(cur.sub || {}), [group]: { ...subCur, [action]: value } } } };
  });
  const setPerfSection = (key, section, value) => setDraft((s) => {
    const cur = s[key] || {};
    const subCur = cur.sub || {};
    return { ...s, [key]: { ...cur, sub: { ...subCur, [section]: value } } };
  });
  const setAllowedTemplates = (key, ids) => setDraft((s) => ({
    ...s, [key]: { ...(s[key] || {}), allowedTemplateIds: ids },
  }));

  return (
    <div className="card overflow-hidden">
      <button className="w-full flex items-center justify-between px-5 py-3 bg-slate-50 dark:bg-slate-800/40 hover:bg-slate-100" onClick={onToggle}>
        <div className="text-left">
          <div className="font-semibold text-slate-800 dark:text-slate-100">
            {employee.name} <span className="text-slate-400 font-normal text-sm">({employee.employeeId || employee.email})</span>
          </div>
          <div className="text-[12px] text-slate-500">
            {employee.role?.toUpperCase()}{employee.isHOD ? ' · HOD' : ''}{employee.department?.name ? ` · ${employee.department.name}` : ''}
            {' · '}<b>{enabledCount}</b> module{enabledCount === 1 ? '' : 's'} enabled
          </div>
        </div>
        <span className="text-slate-400">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="p-5 space-y-4">
          {employee.role !== 'employee' && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 text-amber-800 dark:text-amber-200 px-3 py-2 text-[12px]">
              This account is <b>{employee.role.toUpperCase()}</b> — feature permissions layer on top of role-based defaults but never downgrade access.
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-3">
            {MODULE_CATALOG.map((mod) => (
              <ModuleRow
                key={mod.key}
                mod={mod}
                cfg={draft[mod.key] || {}}
                templates={templates}
                onToggle={(v) => setModule(mod.key, { enabled: v })}
                onLevel={(level) => setModule(mod.key, { level })}
                onSubAction={(g, a, v) => setSub(mod.key, g, a, v)}
                onPerfSection={(section, v) => setPerfSection(mod.key, section, v)}
                onAllowedTemplates={(ids) => setAllowedTemplates(mod.key, ids)}
              />
            ))}
          </div>

          <div className="flex items-center justify-between gap-2 flex-wrap pt-2 border-t border-slate-200 dark:border-slate-700">
            <div className="text-[11px] text-slate-500">
              Last updated: {employee.featurePermissionsUpdatedAt
                ? new Date(employee.featurePermissionsUpdatedAt).toLocaleString() : 'Never'}
            </div>
            <div className="flex items-center gap-2">
              <button className="btn-ghost !py-1 !text-xs" onClick={onOpenCopy}>Copy Permissions…</button>
              <button className="btn-ghost !py-1 !text-xs text-amber-700" onClick={onReset}>Reset Permissions</button>
              <button
                className="btn-primary !py-1 !text-xs"
                disabled={!dirty}
                onClick={() => onSave(draft)}
              >
                {dirty ? 'Save Permissions' : 'Saved'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ----------------- One row in the permissions grid ----------------- */
function ModuleRow({ mod, cfg, templates, onToggle, onLevel, onSubAction, onPerfSection, onAllowedTemplates }) {
  const enabled = !!cfg.enabled;
  return (
    <div className={`rounded-lg border ${enabled ? 'border-brand-300 bg-brand-50/40 dark:bg-brand-500/10' : 'border-slate-200 dark:border-slate-700'} p-3 space-y-2`}>
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
        <span className="font-semibold text-slate-800 dark:text-slate-100">{mod.label}</span>
      </label>

      {enabled && mod.levels && (
        <div className="grid grid-cols-3 gap-1 text-[12px] pl-6">
          {mod.levels.map((lv) => (
            <label key={lv.value} className="flex items-center gap-1 cursor-pointer">
              <input
                type="radio"
                name={`level-${mod.key}-${cfg.__id || ''}`}
                checked={cfg.level === lv.value}
                onChange={() => onLevel(lv.value)}
              />
              {lv.label}
            </label>
          ))}
        </div>
      )}

      {enabled && mod.sub && (
        <div className="pl-6 space-y-1">
          {Object.entries(mod.sub).map(([group, actions]) => (
            <div key={group} className="text-[12px]">
              <div className="font-medium text-slate-600 dark:text-slate-400 capitalize mb-1">{group}</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1">
                {actions.map((act) => (
                  <label key={act} className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!!cfg.sub?.[group]?.[act]}
                      onChange={(e) => onSubAction(group, act, e.target.checked)}
                    />
                    <span className="capitalize">{act}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {enabled && mod.perfSections && (
        <div className="pl-6 grid grid-cols-2 gap-1 text-[12px]">
          {mod.perfSections.map((sec) => (
            <label key={sec.key} className="flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={!!cfg.sub?.[sec.key]}
                onChange={(e) => onPerfSection(sec.key, e.target.checked)}
              />
              {sec.label}
            </label>
          ))}
        </div>
      )}

      {enabled && mod.templateScoped && (
        <div className="pl-6 space-y-1 text-[12px]">
          <div className="text-slate-500">Visible templates (leave empty for all):</div>
          <div className="grid grid-cols-1 gap-0.5 max-h-32 overflow-y-auto rounded border border-slate-200 dark:border-slate-700 p-2">
            {templates.length === 0 ? (
              <span className="text-slate-400 italic">No templates configured.</span>
            ) : templates.map((t) => {
              const allowed = cfg.allowedTemplateIds || [];
              const checked = allowed.length === 0 ? false : allowed.includes(String(t._id));
              return (
                <label key={t._id} className="flex items-center gap-1 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...allowed.filter((x) => x !== String(t._id)), String(t._id)]
                        : allowed.filter((x) => x !== String(t._id));
                      onAllowedTemplates(next);
                    }}
                  />
                  {t.analyticsName || t.title}
                </label>
              );
            })}
          </div>
          {(cfg.allowedTemplateIds?.length || 0) === 0 && (
            <div className="text-[11px] text-amber-700">No templates selected — all are visible to this employee.</div>
          )}
        </div>
      )}
    </div>
  );
}

/* ----------------- Copy Permissions modal ----------------- */
function CopyPermissionsModal({ target, employees, onClose, onCopy }) {
  const [sourceId, setSourceId] = useState('');
  const options = useMemo(() => employees.filter((e) => String(e._id) !== String(target.targetId)), [employees, target.targetId]);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow-xl max-w-md w-full m-4 p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Copy Permissions</h2>
          <p className="text-sm text-slate-500">Replicate every feature-permission value from another employee onto <b>{target.targetName}</b>.</p>
        </div>
        <div>
          <label className="label">Copy from</label>
          <SearchableSelect
            value={sourceId}
            onChange={setSourceId}
            options={options}
            getValue={(e) => e._id}
            getLabel={(e) => `${e.name}${e.employeeId ? ` · ${e.employeeId}` : ''}`}
            placeholder="Pick an employee…"
          />
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!sourceId} onClick={() => onCopy(sourceId)}>Copy</button>
        </div>
      </div>
    </div>
  );
}

const clone = (o) => JSON.parse(JSON.stringify(o || {}));
