import { useState } from 'react';
import useComplianceRegistry from '../../hooks/useComplianceRegistry.js';

/**
 * RuleActionsEditor
 * ------------------------------------------------------------------
 * Ordered list of ComplianceRule.actions.  Each entry renders only
 * the config fields that its `type` actually supports (see
 * ACTION_TYPES[*].configSchema in complianceEnums.js).  The array
 * order is preserved on save so `actions[0]` always fires before
 * `actions[1]`.
 *
 * Reused from:
 *   - Rule Builder → Actions section
 *   - Rule Builder → Escalation step's `actionsAdd`
 *
 * Props:
 *   value:     [{_id?, type, enabled, config}]  (controlled)
 *   onChange:  (next) => void
 *   errors:    optional { rowIndex: {field: message} } map
 *   compact:   boolean -- tighter styling for escalation sub-editor
 *
 * The component does NOT introduce a stable `_id` for freshly-added
 * rows; the backend fills one in on save.  A local `_key` is used
 * only for React reconciliation while editing.
 */
export default function RuleActionsEditor({ value = [], onChange, errors = {}, compact = false }) {
  // QA-fix H4 -- consume backend registry; fallback to local enums.
  const { actionTypes: ACTION_TYPES, findActionSpec } = useComplianceRegistry();
  const rows = value;
  const patch = (i, patchObj) => {
    const next = rows.slice();
    next[i] = { ...next[i], ...patchObj };
    onChange(next);
  };
  const patchConfig = (i, key, val) => {
    const next = rows.slice();
    next[i] = { ...next[i], config: { ...(next[i].config || {}), [key]: val } };
    onChange(next);
  };
  const removeRow = (i) => {
    const next = rows.slice();
    next.splice(i, 1);
    onChange(next);
  };
  const move = (from, to) => {
    if (to < 0 || to >= rows.length) return;
    const next = rows.slice();
    const [row] = next.splice(from, 1);
    next.splice(to, 0, row);
    onChange(next);
  };
  const addRow = () => onChange([
    ...rows,
    { _key: `new_${Date.now()}_${rows.length}`, type: 'notification', enabled: true, config: {} },
  ]);

  // ---- HTML5 native drag/drop.  Kept local; no external dep. ----
  const [dragIdx, setDragIdx] = useState(null);
  const onDragStart = (i) => (e) => {
    setDragIdx(i);
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(i)); } catch { /* Safari sometimes throws */ }
  };
  const onDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
  const onDrop = (i) => (e) => {
    e.preventDefault();
    const from = dragIdx != null ? dragIdx : Number(e.dataTransfer.getData('text/plain'));
    setDragIdx(null);
    if (!Number.isFinite(from) || from === i) return;
    move(from, i);
  };

  return (
    <div className="space-y-2">
      {rows.length === 0 && (
        <div className="text-sm text-slate-500 border border-dashed rounded-md p-4 text-center bg-slate-50">
          No actions yet. Add at least one action so the rule has something to do when it fires.
        </div>
      )}
      {rows.map((row, i) => {
        const spec = findActionSpec(row.type) || { configSchema: [] };
        const err = errors[i] || {};
        const key = row._id || row._key || `row_${i}`;
        return (
          <div
            key={key}
            className={`border rounded-md bg-white ${compact ? 'p-2' : 'p-3'} ${dragIdx === i ? 'opacity-60' : ''}`}
            draggable
            onDragStart={onDragStart(i)}
            onDragOver={onDragOver}
            onDrop={onDrop(i)}
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className="cursor-move text-slate-400 select-none"
                title="Drag to reorder"
                aria-label="Drag handle"
              >
                ⋮⋮
              </span>
              <div className="flex-1 min-w-0">
                <label className="block text-[11px] uppercase text-slate-500 font-semibold">Action type</label>
                <select
                  value={row.type}
                  onChange={(e) => patch(i, { type: e.target.value, config: {} })}
                  className="w-full border rounded-md text-sm px-2 py-1.5"
                >
                  {ACTION_TYPES.map((a) => (
                    <option key={a.value} value={a.value}>{a.label}</option>
                  ))}
                </select>
                {spec.hint && <div className="text-[11px] text-slate-500 mt-1">{spec.hint}</div>}
              </div>
              <div className="flex items-center gap-1">
                <label className="text-xs flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={row.enabled !== false}
                    onChange={(e) => patch(i, { enabled: e.target.checked })}
                  />
                  Enabled
                </label>
                <button type="button" className="btn-secondary !py-1 !px-2 !text-xs" onClick={() => move(i, i - 1)} disabled={i === 0} title="Move up">↑</button>
                <button type="button" className="btn-secondary !py-1 !px-2 !text-xs" onClick={() => move(i, i + 1)} disabled={i === rows.length - 1} title="Move down">↓</button>
                <button type="button" className="btn-secondary !py-1 !px-2 !text-xs text-red-600" onClick={() => removeRow(i)} title="Remove">✕</button>
              </div>
            </div>

            {spec.configSchema.length > 0 && (
              <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2">
                <ActionConfigFields spec={spec} row={row} err={err} patchConfig={patchConfig.bind(null, i)} />
              </div>
            )}
          </div>
        );
      })}

      <div className="pt-1">
        <button type="button" className="btn-secondary !text-xs" onClick={addRow}>
          + Add action
        </button>
      </div>
    </div>
  );
}

/**
 * Per-action config fields.  Rendered only when the action's
 * configSchema advertises the key.  Keeps the UI narrow to the
 * exact backend contract for each action type.
 */
function ActionConfigFields({ spec, row, err, patchConfig }) {
  const { marksStrategies: MARKS_STRATEGIES } = useComplianceRegistry();
  const cfg = row.config || {};
  const NumberField = ({ k, label, min = 0, step = 1, placeholder }) => (
    <label className="block">
      <span className="block text-[11px] uppercase text-slate-500 font-semibold">{label}</span>
      <input
        type="number"
        value={cfg[k] ?? ''}
        min={min}
        step={step}
        placeholder={placeholder}
        onChange={(e) => patchConfig(k, e.target.value === '' ? undefined : Number(e.target.value))}
        className="w-full border rounded-md text-sm px-2 py-1.5"
      />
      {err[k] && <span className="text-[11px] text-red-600">{err[k]}</span>}
    </label>
  );
  const TextField = ({ k, label, placeholder }) => (
    <label className="block md:col-span-2">
      <span className="block text-[11px] uppercase text-slate-500 font-semibold">{label}</span>
      <textarea
        value={cfg[k] || ''}
        placeholder={placeholder}
        rows={2}
        onChange={(e) => patchConfig(k, e.target.value)}
        className="w-full border rounded-md text-sm px-2 py-1.5"
      />
    </label>
  );
  const Select = ({ k, label, options }) => (
    <label className="block">
      <span className="block text-[11px] uppercase text-slate-500 font-semibold">{label}</span>
      <select
        value={cfg[k] ?? ''}
        onChange={(e) => patchConfig(k, e.target.value || undefined)}
        className="w-full border rounded-md text-sm px-2 py-1.5"
      >
        <option value="">— select —</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
  const Toggle = ({ k, label }) => (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={!!cfg[k]}
        onChange={(e) => patchConfig(k, e.target.checked)}
      />
      {label}
    </label>
  );

  return (
    <>
      {spec.configSchema.includes('marks') && (
        <NumberField k="marks" label="Marks (admin_defined floor)" placeholder="e.g. 5" />
      )}
      {spec.configSchema.includes('marksStrategy') && (
        <Select k="marksStrategy" label="Marks strategy" options={MARKS_STRATEGIES} />
      )}
      {spec.configSchema.includes('strategyN') && (
        <NumberField k="N" label="last_n_avg: window (days)" placeholder="7" />
      )}
      {spec.configSchema.includes('amount') && (
        <NumberField k="amount" label="Amount (₹)" step={1} placeholder="e.g. 200" />
      )}
      {spec.configSchema.includes('criticalAmount') && (
        <NumberField k="criticalAmount" label="Amount for critical tasks (₹)" step={1} placeholder="e.g. 500" />
      )}
      {spec.configSchema.includes('percent') && (
        <NumberField k="percent" label="Percent (0–100)" min={0} step={0.5} placeholder="e.g. 5" />
      )}
      {spec.configSchema.includes('percentPerDay') && (
        <NumberField k="percentPerDay" label="Percent per day (recurring)" min={0} step={0.5} placeholder="e.g. 1" />
      )}
      {spec.configSchema.includes('maxCap') && (
        <NumberField k="maxCap" label="Cap (%)" min={0} step={1} placeholder="e.g. 30" />
      )}
      {spec.configSchema.includes('recurring') && (
        <div className="md:col-span-2 flex items-center gap-4 flex-wrap">
          <Toggle k="recurring" label="Recurring (re-fire daily while incident stays active)" />
          {cfg.recurring && (
            <label className="text-xs flex items-center gap-1">
              Cadence
              <select
                value={cfg.recurringCadence || 'daily'}
                onChange={(e) => patchConfig('recurringCadence', e.target.value)}
                className="border rounded-md text-xs px-2 py-1"
              >
                <option value="daily">Daily</option>
              </select>
            </label>
          )}
        </div>
      )}
      {spec.configSchema.includes('template') && (
        <TextField k="template" label="Message template" placeholder="Optional. Leave blank to use rule.name." />
      )}
    </>
  );
}
