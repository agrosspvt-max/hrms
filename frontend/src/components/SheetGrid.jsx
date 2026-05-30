import { useMemo } from 'react';
import DataGrid from 'react-data-grid';
import 'react-data-grid/lib/styles.css';

/**
 * SheetGrid - renders a structure-preserving spreadsheet using
 * react-data-grid.  Used in three places with different `mode`s:
 *
 *   - 'fill'     employee fills editable input cells
 *   - 'readonly' HR review / preview (no editing)
 *
 * Props:
 *   sheet          { columns, rows, cells, rowCount, colCount }
 *   mode           'fill' | 'readonly'              (default 'readonly')
 *   showHidden     reveal hidden rows/cols (HR only) (default false)
 *   onCellChange   (r, c, value) => void            (fill mode)
 *   scoreMap       { [key]: { type, rowIndex, colIndex, maxMarks } }
 *                  used to visually highlight scored cells/rows/cols
 *   height         grid height in px                (default 360)
 */
export default function SheetGrid({
  sheet,
  mode = 'readonly',
  showHidden = false,
  onCellChange,
  onCellClick,
  selectedCell = null,
  scoreMap = {},
  height = 360,
}) {
  const editable = mode === 'fill';

  // ---- fast cell lookup: "r:c" -> cell -------------------------------
  const metaMap = useMemo(() => {
    const m = new Map();
    (sheet?.cells || []).forEach((cell) => m.set(`${cell.r}:${cell.c}`, cell));
    return m;
  }, [sheet]);

  // ---- which cells/rows/cols are scored (for highlighting) -----------
  const { scoredCells, scoredRows, scoredCols } = useMemo(() => {
    const cells = new Set();
    const rows = new Set();
    const cols = new Set();
    Object.values(scoreMap || {}).forEach((s) => {
      if (s.type === 'cell') cells.add(`${s.rowIndex}:${s.colIndex}`);
      else if (s.type === 'row') rows.add(Number(s.rowIndex));
      else if (s.type === 'column') cols.add(Number(s.colIndex));
    });
    return { scoredCells: cells, scoredRows: rows, scoredCols: cols };
  }, [scoreMap]);

  const isScored = (r, c) =>
    scoredCells.has(`${r}:${c}`) || scoredRows.has(r) || scoredCols.has(c);

  // ---- visible rows / columns ---------------------------------------
  // Always render in canonical (numeric index) order - this is the
  // logical spreadsheet order and guards against any array scrambling.
  const visibleRows = useMemo(
    () => (sheet?.rows || [])
      .filter((rw) => showHidden || !rw.hidden)
      .slice()
      .sort((a, b) => a.index - b.index),
    [sheet, showHidden]
  );
  const visibleCols = useMemo(
    () => (sheet?.columns || [])
      .filter((co) => showHidden || !co.hidden)
      .slice()
      .sort((a, b) => a.index - b.index),
    [sheet, showHidden]
  );

  // ---- react-data-grid rows -----------------------------------------
  const rdgRows = useMemo(
    () =>
      visibleRows.map((rw) => {
        const obj = { _r: rw.index, _hidden: rw.hidden };
        visibleCols.forEach((co) => {
          const cell = metaMap.get(`${rw.index}:${co.index}`);
          obj[`c${co.index}`] = cell ? cell.value : '';
        });
        return obj;
      }),
    [visibleRows, visibleCols, metaMap]
  );

  // ---- react-data-grid columns --------------------------------------
  const columns = useMemo(() => {
    const rowHeader = {
      key: '__row',
      name: '',
      frozen: true,
      width: 54,
      resizable: false,
      cellClass: (row) =>
        `rdg-rowhead${scoredRows.has(row._r) ? ' rdg-scored-head' : ''}${row._hidden ? ' rdg-hidden-line' : ''}`,
      renderHeaderCell: () => '',
      renderCell: ({ row }) => {
        const rw = visibleRows.find((x) => x.index === row._r);
        return (
          <span title={rw?.label || ''} className="text-[11px] text-slate-400">
            {row._r + 1}
          </span>
        );
      },
    };

    const dataCols = visibleCols.map((co) => ({
      key: `c${co.index}`,
      name: co.label || '',
      width: co.width || 140,
      resizable: true,
      frozen: co.index === 0,
      cellClass: (row) => {
        const cell = metaMap.get(`${row._r}:${co.index}`);
        const cls = [];
        if (cell?.role === 'label') cls.push('rdg-label-cell');
        else if (cell?.role === 'static') cls.push('rdg-static-cell');
        else if (cell?.role === 'input') cls.push('rdg-input-cell');
        if (isScored(row._r, co.index)) cls.push('rdg-scored-cell');
        if (co.hidden || row._hidden) cls.push('rdg-hidden-line');
        if (selectedCell && selectedCell.r === row._r && selectedCell.c === co.index) cls.push('rdg-selected-cell');
        return cls.join(' ');
      },
      colSpan: (args) => {
        if (args.type !== 'ROW') return undefined;
        const cell = metaMap.get(`${args.row._r}:${co.index}`);
        const span = cell?.merge?.colspan;
        return span && span > 1 ? span : undefined;
      },
      editable: (row) => {
        if (!editable) return false;
        const cell = metaMap.get(`${row._r}:${co.index}`);
        return !!cell && cell.role === 'input' && cell.editable && !cell.mergedInto;
      },
      renderCell: ({ row }) => {
        const cell = metaMap.get(`${row._r}:${co.index}`);
        if (!cell || cell.mergedInto) return null;
        const v = row[`c${co.index}`];
        if (cell.role === 'input') {
          const empty = v === '' || v === null || v === undefined;
          return (
            <span className={empty ? 'text-slate-300' : 'text-slate-800'}>
              {empty ? (editable ? 'Click to fill' : '—') : String(v)}
            </span>
          );
        }
        // label / static
        return <span className={cell.role === 'label' ? 'font-medium text-slate-700' : 'text-slate-600'}>{String(v ?? '')}</span>;
      },
      renderEditCell: (props) => <CellEditor {...props} cell={metaMap.get(`${props.row._r}:${co.index}`)} colKey={`c${co.index}`} />,
    }));

    return [rowHeader, ...dataCols];
  }, [visibleCols, visibleRows, metaMap, editable, scoredRows, scoredCols, scoredCells]);

  const onRowsChange = (newRows, { indexes }) => {
    if (!editable || !onCellChange) return;
    indexes.forEach((idx) => {
      const newRow = newRows[idx];
      const r = newRow._r;
      visibleCols.forEach((co) => {
        const key = `c${co.index}`;
        const cell = metaMap.get(`${r}:${co.index}`);
        if (cell && cell.role === 'input' && cell.editable) {
          const nv = newRow[key];
          const ov = cell.value;
          if (String(nv ?? '') !== String(ov ?? '')) onCellChange(r, co.index, nv);
        }
      });
    });
  };

  if (!sheet || !visibleCols.length) {
    return <div className="text-sm text-slate-400 italic py-6 text-center">No spreadsheet content.</div>;
  }

  return (
    <div className="sheetgrid-wrap">
      <style>{SHEET_GRID_CSS}</style>
      <DataGrid
        className="rdg-light"
        columns={columns}
        rows={rdgRows}
        rowKeyGetter={(row) => row._r}
        onRowsChange={onRowsChange}
        onCellClick={onCellClick ? (args) => {
          const key = args.column?.key;
          if (key && key.startsWith('c')) onCellClick(args.row._r, Number(key.slice(1)));
        } : undefined}
        style={{ height, blockSize: height }}
        defaultColumnOptions={{ resizable: true }}
      />
    </div>
  );
}

/* Per-fieldType inline editor */
function CellEditor({ row, column, onRowChange, onClose, cell, colKey }) {
  const type = cell?.fieldType || 'text';
  const value = row[colKey] ?? '';
  const commit = (v) => onRowChange({ ...row, [colKey]: v });

  if (type === 'number') {
    return (
      <input
        className="rdg-text-editor"
        type="number"
        autoFocus
        value={value === 0 ? 0 : value || ''}
        onChange={(e) => commit(e.target.value === '' ? '' : Number(e.target.value))}
        onBlur={() => onClose(true)}
      />
    );
  }
  if (type === 'date') {
    return (
      <input
        className="rdg-text-editor"
        type="date"
        autoFocus
        value={value || ''}
        onChange={(e) => commit(e.target.value)}
        onBlur={() => onClose(true)}
      />
    );
  }
  if (type === 'dropdown') {
    return (
      <select
        className="rdg-text-editor"
        autoFocus
        value={value || ''}
        onChange={(e) => commit(e.target.value)}
        onBlur={() => onClose(true)}
      >
        <option value="">Select...</option>
        {(cell?.options || []).map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    );
  }
  // text + textarea both edit as single-line in the grid
  return (
    <input
      className="rdg-text-editor"
      autoFocus
      value={value || ''}
      onChange={(e) => commit(e.target.value)}
      onBlur={() => onClose(true)}
    />
  );
}

const SHEET_GRID_CSS = `
.sheetgrid-wrap .rdg { border: 1px solid #e2e8f0; border-radius: 10px; font-size: 13px; }
.sheetgrid-wrap .rdg-header-row { background: #f8fafc; font-weight: 600; color: #475569; }
.sheetgrid-wrap .rdg-cell { display: flex; align-items: center; padding: 0 8px; border-color: #eef2f7; }
.sheetgrid-wrap .rdg-rowhead { background: #f8fafc; justify-content: center; color: #94a3b8; }
.sheetgrid-wrap .rdg-scored-head { background: #fef3c7; }
.sheetgrid-wrap .rdg-label-cell { background: #f1f5f9; font-weight: 500; }
.sheetgrid-wrap .rdg-static-cell { background: #fcfcfd; color: #475569; }
.sheetgrid-wrap .rdg-input-cell { background: #ffffff; }
.sheetgrid-wrap .rdg-scored-cell { box-shadow: inset 0 0 0 9999px rgba(251, 191, 36, 0.10); }
.sheetgrid-wrap .rdg-selected-cell { box-shadow: inset 0 0 0 2px #6366f1; }
.sheetgrid-wrap .rdg-hidden-line { background-image: repeating-linear-gradient(45deg, rgba(148,163,184,0.10) 0 6px, transparent 6px 12px); }
.sheetgrid-wrap .rdg-text-editor { width: 100%; height: 100%; border: 2px solid #6366f1; padding: 0 6px; font-size: 13px; box-sizing: border-box; }
`;
