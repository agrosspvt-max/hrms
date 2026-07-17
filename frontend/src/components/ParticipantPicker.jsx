import { useMemo, useState } from 'react';
import SearchableSelect from './SearchableSelect.jsx';

/**
 * ParticipantPicker
 *
 * Modern replacement for the HTML multi-select participant list.
 * Searchable dropdown adds an employee; every selected employee
 * renders as a removable chip.  Duplicates are prevented.
 *
 * Props:
 *   value       -- array of selected employee _id (strings)
 *   onChange    -- (nextIds) => void
 *   employees   -- pre-loaded [{ _id, name, employeeId, department }]
 *   disabled
 */
export default function ParticipantPicker({ value = [], onChange = () => {}, employees = [], disabled = false }) {
  const [pending, setPending] = useState('');

  const empById = useMemo(() => {
    const m = new Map();
    for (const e of employees || []) m.set(String(e._id), e);
    return m;
  }, [employees]);

  const available = useMemo(() => {
    const chosen = new Set((value || []).map(String));
    return (employees || []).filter((e) => !chosen.has(String(e._id)));
  }, [employees, value]);

  const add = (id) => {
    if (!id || (value || []).some((v) => String(v) === String(id))) return;
    onChange([...(value || []), String(id)]);
    setPending('');   // reset the dropdown after add
  };
  const remove = (id) => onChange((value || []).filter((v) => String(v) !== String(id)));

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2 min-h-[28px]">
        {(value || []).length === 0 && (
          <span className="text-[11px] text-slate-400 italic">No participants added yet.</span>
        )}
        {(value || []).map((id) => {
          const e = empById.get(String(id));
          const label = e
            ? `${e.name}${e.employeeId ? ` · ${e.employeeId}` : ''}`
            : String(id);
          return (
            <span key={String(id)} className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-800">
              {label}
              {!disabled && (
                <button
                  type="button"
                  className="text-slate-400 hover:text-red-600 leading-none"
                  onClick={() => remove(id)}
                  title="Remove participant"
                >×</button>
              )}
            </span>
          );
        })}
      </div>
      {!disabled && (
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <SearchableSelect
              value={pending}
              onChange={(id) => add(id)}
              options={available}
              getValue={(e) => e._id}
              getLabel={(e) => `${e.name}${e.employeeId ? ` · ${e.employeeId}` : ''}${e.department?.name ? ` · ${e.department.name}` : (e.department ? ` · ${e.department}` : '')}`}
              getSearchText={(e) => `${e.name || ''} ${e.employeeId || ''} ${(e.department?.name || e.department || '')}`}
              placeholder={available.length === 0 ? 'All employees already added' : '+ Add participant (search name, ID or department)'}
            />
          </div>
        </div>
      )}
    </div>
  );
}
