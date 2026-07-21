import RuleActionsEditor from './RuleActionsEditor.jsx';

/**
 * RuleEscalationEditor
 * ------------------------------------------------------------------
 * Renders `rule.escalation[]`.  Each step has:
 *   - afterDays: days after `effectiveDate` when the step fires.
 *   - actionsAdd: reuses RuleActionsEditor.
 *
 * Validation forwards inline errors coming from the parent (e.g.
 * `afterDays < 1`, "step 2 has no actions").
 */
export default function RuleEscalationEditor({ value = [], onChange, errors = {} }) {
  const rows = value;
  const patch = (i, patchObj) => {
    const next = rows.slice();
    next[i] = { ...next[i], ...patchObj };
    onChange(next);
  };
  const remove = (i) => {
    const next = rows.slice();
    next.splice(i, 1);
    onChange(next);
  };
  const add = () => onChange([
    ...rows,
    { afterDays: 3, actionsAdd: [] },
  ]);

  return (
    <div className="space-y-2">
      <div className="text-xs text-slate-500">
        Escalation steps run after an incident stays <span className="font-semibold">active</span> for the configured
        number of days. Each step fires <span className="font-semibold">once</span> per incident.
      </div>

      {rows.length === 0 && (
        <div className="text-sm text-slate-500 border border-dashed rounded-md p-4 text-center bg-slate-50">
          No escalation steps configured.
        </div>
      )}

      {rows.map((step, i) => {
        const err = errors[i] || {};
        return (
          <div key={i} className="border rounded-md p-3 bg-white space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="text-[11px] uppercase font-semibold text-slate-500 flex-1">
                Step {i + 1}
              </div>
              <label className="text-xs flex items-center gap-2">
                After
                <input
                  type="number"
                  min={1}
                  value={step.afterDays ?? ''}
                  onChange={(e) => patch(i, { afterDays: Number(e.target.value) })}
                  className="w-20 border rounded-md text-sm px-2 py-1"
                />
                day(s)
              </label>
              <button type="button" className="btn-secondary !py-1 !text-xs text-red-600" onClick={() => remove(i)}>
                Remove step
              </button>
            </div>
            {err.afterDays && <div className="text-[11px] text-red-600">{err.afterDays}</div>}

            <div>
              <div className="text-[11px] uppercase text-slate-500 font-semibold mb-1">Actions to add</div>
              <RuleActionsEditor
                value={step.actionsAdd || []}
                onChange={(next) => patch(i, { actionsAdd: next })}
                errors={err.actionsAdd || {}}
                compact
              />
            </div>
          </div>
        );
      })}

      <div className="pt-1">
        <button type="button" className="btn-secondary !text-xs" onClick={add}>
          + Add escalation step
        </button>
      </div>
    </div>
  );
}
