import { useMemo, useRef } from 'react';
import { RowStatusBadge, DependencyBadge } from './RowStatus.jsx';

/**
 * SheetReviewGrid - HR / HOD reviews an employee's spreadsheet submission
 * INSIDE the spreadsheet itself.  Marks are injected into the sheet
 * structure based on how scoring was configured:
 *
 *   - row scoring     -> a trailing "Marks" (+ "Remark") column, one
 *                        editable mark per scored row.
 *   - column scoring  -> a bottom "Marks" (+ "Remark") row, one editable
 *                        mark per scored column.
 *   - cell scoring    -> the target cell shows the employee value with an
 *                        inline marks input + remark, right where it sits.
 *
 * Rows/columns render in canonical (numeric index) order so the original
 * layout - including any rows the employee appended - is preserved exactly.
 * HR sees hidden / HR-only rows and columns (hatched); the employee never
 * does.  Merged cells keep their row/col spans.
 *
 * UX:
 *   - mark inputs start EMPTY (placeholder), never a preset 0.
 *   - spreadsheet keyboard navigation between mark cells: Arrow keys move
 *     up/down/left/right, Enter moves down, Tab/Shift+Tab move in order.
 *   - the focused mark cell is highlighted.
 *
 * Props:
 *   sheet  submission.sheet { columns, rows, cells, scores }
 *   marks  { [key]: { marksAwarded, remark } }   (controlled; empty = '')
 *   onMark (key, patch) => void
 *   readOnly  disable inputs (default false)
 */
const BIG = 1e6; // sentinel coordinate for the injected marks row/column

export default function SheetReviewGrid({ sheet, marks = {}, onMark, readOnly = false, deps = {} }) {
  const cols = useMemo(
    () => [...(sheet?.columns || [])].sort((a, b) => a.index - b.index),
    [sheet]
  );
  const rows = useMemo(
    () => [...(sheet?.rows || [])].sort((a, b) => a.index - b.index),
    [sheet]
  );
  const cellMap = useMemo(() => {
    const m = new Map();
    (sheet?.cells || []).forEach((c) => m.set(`${c.r}:${c.c}`, c));
    return m;
  }, [sheet]);

  const { rowScore, colScore, cellScore } = useMemo(() => {
    const rs = new Map();
    const cs = new Map();
    const cl = new Map();
    (sheet?.scores || []).forEach((s) => {
      if (s.type === 'row') rs.set(s.rowIndex, s);
      else if (s.type === 'column') cs.set(s.colIndex, s);
      else if (s.type === 'cell') cl.set(`${s.rowIndex}:${s.colIndex}`, s);
    });
    return { rowScore: rs, colScore: cs, cellScore: cl };
  }, [sheet]);

  const hasRowMarks = rowScore.size > 0;
  const hasColMarks = colScore.size > 0;
  // Show a Status column when any row score carries workflow status tracking.
  const hasRowStatus = [...rowScore.values()].some((s) => s.rowStatus || s.statusTracking);

  // ---- keyboard navigation registry: nav-coord "r:c" -> input el ----
  const regRef = useRef(new Map());
  const register = (navR, navC) => (el) => {
    const key = `${navR}:${navC}`;
    if (el) regRef.current.set(key, { r: navR, c: navC, el });
    else regRef.current.delete(key);
  };
  const navKeyDown = (e, navR, navC) => {
    const k = e.key;
    const isArrow = k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight';
    if (!isArrow && k !== 'Enter') return;
    // On number inputs, stop the arrow keys from nudging the value.
    if (isArrow && e.target.type === 'number') e.preventDefault();

    let dir;
    if (k === 'ArrowDown' || k === 'Enter') dir = 'down';
    else if (k === 'ArrowUp') dir = 'up';
    else if (k === 'ArrowRight') dir = 'right';
    else dir = 'left';

    let best = null;
    for (const it of regRef.current.values()) {
      if (dir === 'down' && it.c === navC && it.r > navR && (!best || it.r < best.r)) best = it;
      else if (dir === 'up' && it.c === navC && it.r < navR && (!best || it.r > best.r)) best = it;
      else if (dir === 'right' && it.r === navR && it.c > navC && (!best || it.c < best.c)) best = it;
      else if (dir === 'left' && it.r === navR && it.c < navC && (!best || it.c > best.c)) best = it;
    }
    if (best) {
      e.preventDefault();
      best.el.focus();
      best.el.select?.();
    } else if (k === 'Enter') {
      e.preventDefault();
    }
  };

  if (!sheet || !cols.length) {
    return <div className="text-sm text-slate-400 italic py-6 text-center">No spreadsheet content.</div>;
  }

  const fmt = (v) => (v === '' || v === null || v === undefined ? '' : String(v));
  // A mark value is "entered" only when it is a real number (incl. 0);
  // undefined / '' renders as an empty field with a placeholder.
  const markVal = (key) => {
    const v = marks[key]?.marksAwarded;
    return v === 0 || (typeof v === 'number' && !Number.isNaN(v)) ? v : '';
  };

  const MarkInput = ({ score, navR, navC }) => (
    <span className="srg-mark">
      <input
        type="number" min="0" max={score.maxMarks}
        className="srg-mark-in"
        disabled={readOnly}
        placeholder="Marks"
        ref={register(navR, navC)}
        data-nav={`${navR}:${navC}`}
        onKeyDown={(e) => navKeyDown(e, navR, navC)}
        value={markVal(score.key)}
        onChange={(e) => onMark(score.key, { marksAwarded: e.target.value === '' ? '' : Number(e.target.value) })}
      />
      <span className="srg-mark-max">/ {score.maxMarks}</span>
    </span>
  );

  const RemarkInput = ({ score }) => (
    <input
      className="srg-remark-in"
      disabled={readOnly}
      placeholder="Remark"
      value={marks[score.key]?.remark ?? ''}
      onChange={(e) => onMark(score.key, { remark: e.target.value })}
    />
  );

  return (
    <div className="srg-wrap">
      <style>{SRG_CSS}</style>
      <div className="srg-scroll">
        <table className="srg-table">
          <thead>
            <tr>
              <th className="srg-rownum">#</th>
              {cols.map((co) => (
                <th key={co.index} className={co.hidden ? 'srg-hidden' : ''} style={{ minWidth: co.width || 120 }}>
                  {co.label || ''}
                  {co.hidden && <span className="srg-hr-tag">HR</span>}
                </th>
              ))}
              {hasRowMarks && <th className="srg-mark-head">Marks</th>}
              {hasRowMarks && <th className="srg-mark-head">Remark</th>}
              {hasRowStatus && <th className="srg-mark-head">Status</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((rw) => {
              const rs = rowScore.get(rw.index);
              return (
                <tr key={rw.index} className={rw.hidden ? 'srg-hidden-row' : ''}>
                  <td className="srg-rownum" title={rw.label}>{rw.index + 1}</td>
                  {cols.map((co) => {
                    const cell = cellMap.get(`${rw.index}:${co.index}`);
                    if (cell && cell.mergedInto) return null; // covered by a merge
                    const span = cell?.merge || {};
                    const cScore = cellScore.get(`${rw.index}:${co.index}`);
                    const hiddenCls = (co.hidden || rw.hidden) ? 'srg-hidden' : '';
                    const role = cell?.role || 'input';
                    const value = fmt(cell?.value);

                    return (
                      <td
                        key={co.index}
                        colSpan={span.colspan > 1 ? span.colspan : undefined}
                        rowSpan={span.rowspan > 1 ? span.rowspan : undefined}
                        className={[
                          hiddenCls,
                          role === 'label' ? 'srg-label' : role === 'static' ? 'srg-static' : 'srg-input',
                          cScore ? 'srg-cell-scored' : '',
                        ].join(' ')}
                      >
                        {cScore ? (
                          <div className="srg-cellscore">
                            <span className="srg-cellval">{value || <span className="srg-empty">—</span>}</span>
                            <span className="srg-cellmark">
                              <MarkInput score={cScore} navR={rw.index} navC={co.index} />
                            </span>
                            <RemarkInput score={cScore} />
                          </div>
                        ) : value === '' ? (
                          role === 'input' ? <span className="srg-empty">—</span> : ''
                        ) : (
                          value
                        )}
                      </td>
                    );
                  })}
                  {hasRowMarks && (
                    <td className="srg-mark-cell">
                      {rs ? <MarkInput score={rs} navR={rw.index} navC={BIG} /> : <span className="srg-empty">—</span>}
                    </td>
                  )}
                  {hasRowMarks && (
                    <td className="srg-mark-cell">
                      {rs ? <RemarkInput score={rs} /> : <span className="srg-empty">—</span>}
                    </td>
                  )}
                  {hasRowStatus && (
                    <td className="srg-mark-cell">
                      {rs && (rs.rowStatus || deps[rs.key]) ? (
                        <div className="flex flex-col gap-1 items-start" title={deps[rs.key] ? `Forwarded to ${deps[rs.key].assignedToName}${deps[rs.key].resolvedAt ? ` · resolved in ${deps[rs.key].resolutionHours}h` : ' · awaiting resolution'}` : ''}>
                          <RowStatusBadge status={rs.rowStatus} />
                          {deps[rs.key] && <DependencyBadge dep={deps[rs.key]} />}
                        </div>
                      ) : <span className="srg-empty">—</span>}
                    </td>
                  )}
                </tr>
              );
            })}

            {/* Bottom marks row for column scoring */}
            {hasColMarks && (
              <tr className="srg-foot">
                <td className="srg-rownum srg-foot-label">Marks</td>
                {cols.map((co) => {
                  const cs = colScore.get(co.index);
                  return (
                    <td key={co.index} className="srg-mark-cell">
                      {cs ? <MarkInput score={cs} navR={BIG} navC={co.index} /> : ''}
                    </td>
                  );
                })}
                {hasRowMarks && <td className="srg-mark-cell" />}
                {hasRowMarks && <td className="srg-mark-cell" />}
                {hasRowStatus && <td className="srg-mark-cell" />}
              </tr>
            )}
            {hasColMarks && (
              <tr className="srg-foot">
                <td className="srg-rownum srg-foot-label">Remark</td>
                {cols.map((co) => {
                  const cs = colScore.get(co.index);
                  return (
                    <td key={co.index} className="srg-mark-cell">
                      {cs ? <RemarkInput score={cs} /> : ''}
                    </td>
                  );
                })}
                {hasRowMarks && <td className="srg-mark-cell" />}
                {hasRowMarks && <td className="srg-mark-cell" />}
                {hasRowStatus && <td className="srg-mark-cell" />}
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {!readOnly && (hasRowMarks || hasColMarks || cellScore.size > 0) && (
        <div className="text-[11px] text-slate-400 mt-1">
          Tip: use arrow keys / Enter / Tab to move between mark cells, just like a spreadsheet.
        </div>
      )}
    </div>
  );
}

const SRG_CSS = `
.srg-wrap { font-size: 13px; }
.srg-scroll { max-height: 460px; overflow: auto; border: 1px solid #e2e8f0; border-radius: 10px; }
.srg-table { border-collapse: separate; border-spacing: 0; width: 100%; }
.srg-table th, .srg-table td { border-right: 1px solid #eef2f7; border-bottom: 1px solid #eef2f7; padding: 6px 8px; text-align: left; vertical-align: top; }
.srg-table thead th { position: sticky; top: 0; z-index: 2; background: #f8fafc; font-weight: 600; color: #475569; white-space: nowrap; }
.srg-rownum { width: 40px; text-align: center; color: #94a3b8; background: #f8fafc; position: sticky; left: 0; z-index: 1; font-size: 11px; }
.srg-table thead th.srg-rownum { z-index: 3; }
.srg-label { background: #f1f5f9; font-weight: 500; color: #334155; }
.srg-static { background: #fcfcfd; color: #475569; }
.srg-input { background: #ffffff; color: #1e293b; }
.srg-empty { color: #cbd5e1; }
.srg-hidden { background-image: repeating-linear-gradient(45deg, rgba(148,163,184,0.10) 0 6px, transparent 6px 12px); }
.srg-hr-tag { display: inline-block; margin-left: 4px; font-size: 9px; font-weight: 700; color: #64748b; background: #e2e8f0; border-radius: 4px; padding: 0 4px; vertical-align: middle; }
.srg-mark-head { background: #fef3c7 !important; color: #92400e !important; }
.srg-mark-cell { background: #fffbeb; white-space: nowrap; }
.srg-cell-scored { background: #fffbeb; box-shadow: inset 0 0 0 1px #fcd34d; }
.srg-cellscore { display: flex; flex-direction: column; gap: 3px; }
.srg-cellval { font-weight: 500; color: #1e293b; }
.srg-mark { display: inline-flex; align-items: center; gap: 4px; }
.srg-mark-in { width: 56px; border: 1px solid #cbd5e1; border-radius: 6px; padding: 2px 4px; font-size: 12px; }
.srg-mark-in:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99,102,241,0.35); background: #eef2ff; }
.srg-mark-max { font-size: 11px; color: #92400e; }
.srg-remark-in { width: 100%; min-width: 90px; margin-top: 2px; border: 1px solid #e2e8f0; border-radius: 6px; padding: 2px 4px; font-size: 11px; }
.srg-remark-in:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99,102,241,0.25); }
.srg-foot td { background: #fef9c3; font-weight: 500; }
.srg-foot-label { font-weight: 700 !important; color: #92400e !important; background: #fde68a !important; }
`;
