const XLSX = require('xlsx');

/**
 * sheetParser
 *
 * Parses an uploaded workbook into a structure-preserving 2-D grid for the
 * advanced "sheet" reporting templates.  Unlike utils/excelParser.js (which
 * flattens a workbook into a flat list of columns), this keeps the original
 * row/column layout, labels, merged-cell metadata and column widths so the
 * sheet can be rendered inside the HRMS almost exactly as uploaded.
 *
 * Returns:
 *   {
 *     sheetName, rowCount, colCount,
 *     columns: [{ index, label, width, hidden }],
 *     rows:    [{ index, label, hidden }],
 *     cells:   [{ r, c, value, role, fieldType, editable, hidden,
 *                 options, merge?, mergedInto? }],
 *     scoring: []           // HR configures this in the UI afterwards
 *   }
 *
 * Role inference (HR can override every cell in the config UI):
 *   - row 0                       -> 'label'  (column headers)
 *   - column 0 with a value       -> 'label'  (row headers, e.g. "Day1")
 *   - any other cell with a value -> 'static' (preset, read-only)
 *   - empty data cell             -> 'input'  (employee fills it)
 */

const EXCEL_EPOCH = Date.UTC(1899, 11, 30); // 1899-12-30, Excel serial origin

const cellValue = (cell) => {
  if (!cell) return '';
  // Dates -> ISO yyyy-mm-dd
  if (cell.t === 'd' && cell.v instanceof Date) {
    return cell.v.toISOString().substring(0, 10);
  }
  if (cell.v === undefined || cell.v === null) return '';
  return cell.v;
};

const inferType = (sample) => {
  if (sample === undefined || sample === null || sample === '') return 'text';
  if (typeof sample === 'number') return 'number';
  if (sample instanceof Date) return 'date';
  if (typeof sample === 'string') {
    if (sample.length > 60) return 'textarea';
    if (/^\d{4}-\d{2}-\d{2}/.test(sample)) return 'date';
    if (/^-?\d+(\.\d+)?$/.test(sample.trim())) return 'number';
  }
  return 'text';
};

const parseWorkbookToSheet = (buffer) => {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('Workbook has no sheets');
  const ws = wb.Sheets[sheetName];
  if (!ws || !ws['!ref']) throw new Error('Sheet is empty');

  const range = XLSX.utils.decode_range(ws['!ref']);
  const startR = range.s.r;
  const startC = range.s.c;
  const rowCount = range.e.r - startR + 1;
  const colCount = range.e.c - startC + 1;

  // ---- raw values into a dense matrix (normalised to 0-based) -------
  const matrix = [];
  for (let r = 0; r < rowCount; r++) {
    const row = [];
    for (let c = 0; c < colCount; c++) {
      const addr = XLSX.utils.encode_cell({ r: r + startR, c: c + startC });
      row.push(cellValue(ws[addr]));
    }
    matrix.push(row);
  }

  // ---- per-column field-type inference (from first non-empty value) -
  const colType = [];
  for (let c = 0; c < colCount; c++) {
    let sample;
    for (let r = 1; r < rowCount; r++) {
      const v = matrix[r][c];
      if (v !== '' && v !== null && v !== undefined) { sample = v; break; }
    }
    colType[c] = inferType(sample);
  }

  // ---- column / row metadata ----------------------------------------
  const wsCols = ws['!cols'] || [];
  const wsRows = ws['!rows'] || [];

  const columns = [];
  for (let c = 0; c < colCount; c++) {
    const header = matrix[0][c];
    const meta = wsCols[c + startC] || {};
    const wch = Number(meta.wch);
    columns.push({
      index: c,
      label: String(header || '').trim() || XLSX.utils.encode_col(c + startC),
      width: Number.isFinite(wch) && wch > 0 ? Math.round(wch * 7 + 12) : 140,
      hidden: !!meta.hidden,
    });
  }

  const rows = [];
  for (let r = 0; r < rowCount; r++) {
    const label0 = matrix[r][0];
    const meta = wsRows[r + startR] || {};
    rows.push({
      index: r,
      label: String(label0 || '').trim() || String(r + 1),
      hidden: !!meta.hidden,
    });
  }

  // ---- merged-cell metadata -----------------------------------------
  // master cell -> { rowspan, colspan }; covered cells -> { mergedInto }
  const mergeMaster = new Map(); // "r:c" -> { rowspan, colspan }
  const mergeCovered = new Map(); // "r:c" -> { r, c }  (master coords)
  (ws['!merges'] || []).forEach((m) => {
    const mr = m.s.r - startR;
    const mc = m.s.c - startC;
    const rowspan = m.e.r - m.s.r + 1;
    const colspan = m.e.c - m.s.c + 1;
    if (mr < 0 || mc < 0) return;
    mergeMaster.set(`${mr}:${mc}`, { rowspan, colspan });
    for (let r = m.s.r; r <= m.e.r; r++) {
      for (let c = m.s.c; c <= m.e.c; c++) {
        if (r === m.s.r && c === m.s.c) continue;
        mergeCovered.set(`${r - startR}:${c - startC}`, { r: mr, c: mc });
      }
    }
  });

  // ---- build cells ---------------------------------------------------
  const cells = [];
  for (let r = 0; r < rowCount; r++) {
    for (let c = 0; c < colCount; c++) {
      const value = matrix[r][c];
      const hasValue = value !== '' && value !== null && value !== undefined;

      let role;
      if (r === 0) role = 'label';
      else if (c === 0 && hasValue) role = 'label';
      else if (hasValue) role = 'static';
      else role = 'input';

      const cell = {
        r,
        c,
        value: role === 'input' ? '' : value,
        role,
        fieldType: colType[c] || 'text',
        editable: role === 'input',
        hidden: false,
        options: [],
      };

      const key = `${r}:${c}`;
      if (mergeMaster.has(key)) cell.merge = mergeMaster.get(key);
      if (mergeCovered.has(key)) cell.mergedInto = mergeCovered.get(key);

      cells.push(cell);
    }
  }

  return {
    sheetName,
    rowCount,
    colCount,
    columns,
    rows,
    cells,
    scoring: [],
  };
};

module.exports = { parseWorkbookToSheet };
