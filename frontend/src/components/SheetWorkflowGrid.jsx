import { useMemo, useRef, useCallback } from 'react';

const fmt = (v) => (v === '' || v === null || v === undefined ? '' : String(v));

/**
 * Module-level editable cell renderer.
 *
 * Defined OUTSIDE the SheetWorkflowGrid function body on purpose: when this
 * component was nested inside the parent, every parent re-render created a
 * brand-new component identity, which made React unmount/remount the input
 * on every keystroke - which is exactly what caused focus loss while
 * typing.  Hoisting it makes the identity stable so React just updates the
 * value attribute and keeps the cursor in place.
 *
 * `data-cell="r:c"` is also stamped on every editable input so the grid's
 * keyboard handler can find the next cell for arrow / Tab / Enter
 * navigation without a brittle refs map.
 */
function EditCell({ cell, r, c, onCellChange }) {
  const type = cell.fieldType || 'text';
  const v = cell.value;
  const commit = (val) => onCellChange && onCellChange(r, c, val);
  const cellAttr = `${r}:${c}`;
  if (type === 'number') {
    return <input className="swg-in" type="number" data-cell={cellAttr}
      value={v === 0 ? 0 : (v || '')}
      onChange={(e) => commit(e.target.value === '' ? '' : Number(e.target.value))} placeholder="—" />;
  }
  if (type === 'date') {
    return <input className="swg-in" type="date" data-cell={cellAttr}
      value={v || ''} onChange={(e) => commit(e.target.value)} />;
  }
  if (type === 'textarea') {
    return <textarea className="swg-in" rows={1} data-cell={cellAttr}
      value={v || ''} onChange={(e) => commit(e.target.value)} placeholder="—" />;
  }
  if (type === 'dropdown') {
    return (
      <select className="swg-in" data-cell={cellAttr} value={v || ''} onChange={(e) => commit(e.target.value)}>
        <option value="">Select…</option>
        {(cell.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  return <input className="swg-in" data-cell={cellAttr}
    value={v || ''} onChange={(e) => commit(e.target.value)} placeholder="—" />;
}

/**
 * Module-level inline workflow cells (Status / Type / Assign To / Note).
 * Same rationale as EditCell - stable identity prevents focus loss while
 * typing in the dependency remark / pending reason inputs.
 */
function WorkflowCells({ score, status, onStatusChange, assignable }) {
  const st = status[score.key] || { dependencyType: 'independent' };
  const rowStatus = st.rowStatus || '';
  const isDependent = st.dependencyType === 'dependent';
  const showType = rowStatus === 'done' || rowStatus === 'pending';
  const ch = (patch) => onStatusChange && onStatusChange(score.key, patch);

  return (
    <>
      <td className="swg-wf-cell">
        <select className={`swg-status swg-status-${rowStatus || 'none'}`}
          value={rowStatus} onChange={(e) => ch({ rowStatus: e.target.value })}>
          <option value="">Select…</option>
          <option value="done">Done</option>
          <option value="pending">Pending</option>
          <option value="work_not_available">Work Not Available</option>
        </select>
      </td>
      <td className="swg-wf-cell">
        {showType ? (
          <div className="swg-type">
            <label><input type="radio" name={`wt-${score.key}`} checked={!isDependent} onChange={() => ch({ dependencyType: 'independent' })} /> Indep.</label>
            <label><input type="radio" name={`wt-${score.key}`} checked={isDependent} onChange={() => ch({ dependencyType: 'dependent' })} /> Depend.</label>
          </div>
        ) : <span className="swg-empty">—</span>}
      </td>
      <td className="swg-wf-cell">
        {showType && isDependent ? (
          <select className="swg-in" value={st.dependencyAssignedTo || ''} onChange={(e) => ch({ dependencyAssignedTo: e.target.value })}>
            <option value="">Select person…</option>
            {(assignable || []).map((u) => (
              <option key={u._id} value={u._id}>
                {u.name}{u.role ? ` · ${u.role === 'super_admin' ? 'Super Admin' : u.role.toUpperCase()}` : ''}{u.isHOD ? ' · HOD' : ''}
              </option>
            ))}
          </select>
        ) : <span className="swg-empty">—</span>}
      </td>
      <td className="swg-wf-cell">
        {(rowStatus === 'pending' || (showType && isDependent)) ? (
          <div className="swg-notes">
            {rowStatus === 'pending' && (
              <input className="swg-in" placeholder="Pending reason (required)" value={st.pendingReason || ''} onChange={(e) => ch({ pendingReason: e.target.value })} />
            )}
            {showType && isDependent && (
              <input className="swg-in" placeholder="Dependency remark (required)" value={st.dependencyRemark || ''} onChange={(e) => ch({ dependencyRemark: e.target.value })} />
            )}
          </div>
        ) : <span className="swg-empty">—</span>}
      </td>
    </>
  );
}

/**
 * SheetWorkflowGrid - the EMPLOYEE fill view of a spreadsheet report, where
 * the spreadsheet IS the workflow.  It renders the original grid as an
 * editable HTML table (mirroring the HR SheetReviewGrid layout) and, for
 * every scored row HR flagged with `statusTracking`, appends inline
 * workflow columns ON THE SAME ROW:
 *
 *   STATUS  -> Done / Pending / Work Not Available
 *   TYPE    -> Independent / Dependent           (only when Done/Pending)
 *   ASSIGN  -> any active account                (only when Dependent)
 *   NOTE    -> pending reason and/or dependency remark
 *
 * Editable input cells stay fully editable; label/static cells are read
 * only; hidden rows/columns are never shown to the employee; merged cells
 * keep their spans; row/column/cell scoring highlights are preserved.
 *
 * Props:
 *   sheet          working sheet { columns, rows, cells, scores, rowCount }
 *   onCellChange   (r, c, value) => void
 *   status         { [scoreKey]: { rowStatus, pendingReason, dependencyType,
 *                    dependencyAssignedTo, dependencyRemark } }
 *   onStatusChange (scoreKey, patch) => void
 *   assignable     [{ _id, name, role, isHOD }]
 */
export default function SheetWorkflowGrid({ sheet, onCellChange, status = {}, onStatusChange, assignable = [] }) {
  const cols = useMemo(
    () => [...(sheet?.columns || [])].filter((c) => !c.hidden).sort((a, b) => a.index - b.index),
    [sheet]
  );
  const rows = useMemo(
    () => [...(sheet?.rows || [])].filter((r) => !r.hidden).sort((a, b) => a.index - b.index),
    [sheet]
  );
  const cellMap = useMemo(() => {
    const m = new Map();
    (sheet?.cells || []).forEach((c) => m.set(`${c.r}:${c.c}`, c));
    return m;
  }, [sheet]);

  // Scoring maps (for highlight) + the task rows (row scoring + statusTracking).
  const { rowScore, colScore, cellScore, taskRows } = useMemo(() => {
    const rs = new Map(); const cs = new Map(); const cl = new Map(); const tr = new Map();
    (sheet?.scores || []).forEach((s) => {
      if (s.type === 'row') { rs.set(s.rowIndex, s); if (s.statusTracking) tr.set(s.rowIndex, s); }
      else if (s.type === 'column') cs.set(s.colIndex, s);
      else if (s.type === 'cell') cl.set(`${s.rowIndex}:${s.colIndex}`, s);
    });
    return { rowScore: rs, colScore: cs, cellScore: cl, taskRows: tr };
  }, [sheet]);

  const hasTaskRows = taskRows.size > 0;

  // Container ref + key handler power Arrow / Tab / Enter navigation
  // between editable cells.  We delegate keydown on the container instead
  // of maintaining a refs map — `data-cell="r:c"` on every editable input
  // is the single source of truth, so adding rows / columns Just Works.
  const wrapRef = useRef(null);
  const onKeyDown = useCallback((e) => {
    const t = e.target;
    if (!t || !t.getAttribute) return;
    const tag = t.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') return;
    const attr = t.getAttribute('data-cell');
    if (!attr) return;
    const [rStr, cStr] = attr.split(':');
    const r = Number(rStr); const c = Number(cStr);
    if (!Number.isFinite(r) || !Number.isFinite(c)) return;

    const find = (rr, cc) => wrapRef.current?.querySelector(`[data-cell="${rr}:${cc}"]`);
    const cellsByCol = (cc) => Array.from(wrapRef.current?.querySelectorAll(`[data-cell$=":${cc}"]`) || [])
      .map((el) => Number(el.getAttribute('data-cell').split(':')[0]))
      .filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    const cellsByRow = (rr) => Array.from(wrapRef.current?.querySelectorAll(`[data-cell^="${rr}:"]`) || [])
      .map((el) => Number(el.getAttribute('data-cell').split(':')[1]))
      .filter((n) => Number.isFinite(n)).sort((a, b) => a - b);

    const move = (next) => {
      if (next) {
        e.preventDefault();
        next.focus();
        if (next.select) next.select();
      }
    };

    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      if (e.key === 'ArrowDown' && t.type === 'number') e.preventDefault();
      const rows = cellsByCol(c); const next = rows.find((rr) => rr > r);
      move(next != null ? find(next, c) : null);
    } else if (e.key === 'ArrowUp') {
      if (t.type === 'number') e.preventDefault();
      const rows = cellsByCol(c); const prev = [...rows].reverse().find((rr) => rr < r);
      move(prev != null ? find(prev, c) : null);
    } else if (e.key === 'ArrowRight') {
      const cells = cellsByRow(r); const next = cells.find((cc) => cc > c);
      move(next != null ? find(r, next) : null);
    } else if (e.key === 'ArrowLeft') {
      const cells = cellsByRow(r); const prev = [...cells].reverse().find((cc) => cc < c);
      move(prev != null ? find(r, prev) : null);
    } else if (e.key === 'Tab') {
      // Move to next/previous editable spreadsheet cell, keeping focus
      // inside the grid.  Workflow controls remain reachable via Tab too
      // because the browser tabs through them after the last data cell.
      const cells = cellsByRow(r);
      if (e.shiftKey) {
        const prev = [...cells].reverse().find((cc) => cc < c);
        if (prev != null) move(find(r, prev));
        else {
          const rows = cellsByCol(c); const prevRow = [...rows].reverse().find((rr) => rr < r);
          if (prevRow != null) {
            const lastCol = cellsByRow(prevRow).slice(-1)[0];
            if (lastCol != null) move(find(prevRow, lastCol));
          }
        }
      } else {
        const next = cells.find((cc) => cc > c);
        if (next != null) move(find(r, next));
        else {
          const rows = cellsByCol(c); const nextRow = rows.find((rr) => rr > r);
          if (nextRow != null) {
            const firstCol = cellsByRow(nextRow)[0];
            if (firstCol != null) move(find(nextRow, firstCol));
          }
        }
      }
    }
  }, []);

  if (!sheet || !cols.length) {
    return <div className="text-sm text-slate-400 italic py-6 text-center">No spreadsheet content.</div>;
  }

  return (
    <div className="swg-wrap" ref={wrapRef} onKeyDown={onKeyDown}>
      <style>{SWG_CSS}</style>
      <div className="swg-scroll">
        <table className="swg-table">
          <thead>
            <tr>
              <th className="swg-rownum">#</th>
              {cols.map((co) => <th key={co.index} style={{ minWidth: co.width || 120 }}>{co.label || ''}</th>)}
              {hasTaskRows && <th className="swg-wf-head">Status</th>}
              {hasTaskRows && <th className="swg-wf-head">Work Type</th>}
              {hasTaskRows && <th className="swg-wf-head">Assign To</th>}
              {hasTaskRows && <th className="swg-wf-head">Note</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((rw) => {
              const taskScore = taskRows.get(rw.index);
              return (
                <tr key={rw.index} className={taskScore ? 'swg-task-row' : ''}>
                  <td className="swg-rownum" title={rw.label}>{rw.index + 1}</td>
                  {cols.map((co) => {
                    const cell = cellMap.get(`${rw.index}:${co.index}`);
                    if (cell && cell.mergedInto) return null;
                    const span = cell?.merge || {};
                    const role = cell?.role || 'input';
                    const scored = rowScore.has(rw.index) || colScore.has(co.index) || cellScore.has(`${rw.index}:${co.index}`);
                    const editable = !!cell && role === 'input' && cell.editable && !cell.mergedInto;
                    return (
                      <td
                        key={co.index}
                        colSpan={span.colspan > 1 ? span.colspan : undefined}
                        rowSpan={span.rowspan > 1 ? span.rowspan : undefined}
                        className={[
                          role === 'label' ? 'swg-label' : role === 'static' ? 'swg-static' : 'swg-input',
                          scored ? 'swg-scored' : '',
                        ].join(' ')}
                      >
                        {editable ? <EditCell cell={cell} r={rw.index} c={co.index} onCellChange={onCellChange} />
                          : role === 'input' ? (fmt(cell?.value) || <span className="swg-empty">—</span>)
                          : fmt(cell?.value)}
                      </td>
                    );
                  })}
                  {hasTaskRows && (
                    taskScore
                      ? <WorkflowCells score={taskScore} status={status} onStatusChange={onStatusChange} assignable={assignable} />
                      : <><td className="swg-wf-cell swg-na" colSpan={4}><span className="swg-empty">—</span></td></>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hasTaskRows && (
        <div className="text-[11px] text-slate-400 mt-1">
          Set a <b>Status</b> for each highlighted task row. Choose <b>Dependent</b> to hand the row to another team member.
        </div>
      )}
    </div>
  );
}

const SWG_CSS = `
.swg-wrap { font-size: 13px; }
.swg-scroll { max-height: 520px; overflow: auto; border: 1px solid #e2e8f0; border-radius: 10px; }
.swg-table { border-collapse: separate; border-spacing: 0; width: 100%; }
.swg-table th, .swg-table td { border-right: 1px solid #eef2f7; border-bottom: 1px solid #eef2f7; padding: 5px 8px; text-align: left; vertical-align: top; }
.swg-table thead th { position: sticky; top: 0; z-index: 2; background: #f8fafc; font-weight: 600; color: #475569; white-space: nowrap; }
.swg-rownum { width: 40px; text-align: center; color: #94a3b8; background: #f8fafc; position: sticky; left: 0; z-index: 1; font-size: 11px; }
.swg-table thead th.swg-rownum { z-index: 3; }
.swg-label { background: #f1f5f9; font-weight: 500; color: #334155; }
.swg-static { background: #fcfcfd; color: #475569; }
.swg-input { background: #ffffff; color: #1e293b; }
.swg-scored { box-shadow: inset 0 0 0 9999px rgba(251, 191, 36, 0.08); }
.swg-task-row td { background: #fffdf5; }
.swg-empty { color: #cbd5e1; }
.swg-in { width: 100%; min-width: 90px; border: 1px solid #cbd5e1; border-radius: 6px; padding: 3px 6px; font-size: 12px; box-sizing: border-box; background: #fff; }
.swg-in:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99,102,241,0.25); }
.swg-wf-head { background: #eef2ff !important; color: #3730a3 !important; white-space: nowrap; }
.swg-wf-cell { background: #fafaff; min-width: 120px; white-space: nowrap; }
.swg-na { text-align: center; }
.swg-status { width: 100%; min-width: 130px; border: 1px solid #cbd5e1; border-radius: 6px; padding: 3px 6px; font-size: 12px; font-weight: 600; }
.swg-status-done { color: #15803d; border-color: #86efac; background: #f0fdf4; }
.swg-status-pending { color: #b45309; border-color: #fcd34d; background: #fffbeb; }
.swg-status-work_not_available { color: #64748b; background: #f1f5f9; }
.swg-type { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: #475569; white-space: nowrap; }
.swg-type label { display: flex; align-items: center; gap: 3px; cursor: pointer; }
.swg-notes { display: flex; flex-direction: column; gap: 4px; min-width: 160px; }
`;
