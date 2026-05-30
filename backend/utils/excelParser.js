const XLSX = require('xlsx');

/**
 * Parse an uploaded Excel/CSV file buffer.  Reads the first sheet,
 * treats the first non-empty row as column headers, and returns:
 *
 *   {
 *     columns: [{ fieldName, fieldType, markEligible, maxMarks, options }],
 *     preview: [ first 5 data rows as { fieldName: value, ... } ]
 *   }
 *
 * Field types are inferred from the first non-empty value below each
 * column header.  HR can override them in the UI before saving.
 */
const inferType = (sample) => {
  if (sample === undefined || sample === null || sample === '') return 'text';
  if (typeof sample === 'number') return 'number';
  if (sample instanceof Date) return 'date';
  if (typeof sample === 'string') {
    // Long strings -> textarea
    if (sample.length > 60) return 'textarea';
    // Looks like an ISO/date string?
    if (/^\d{4}-\d{2}-\d{2}/.test(sample)) return 'date';
    // Pure number string?
    if (/^-?\d+(\.\d+)?$/.test(sample.trim())) return 'number';
  }
  return 'text';
};

const parseBuffer = (buffer) => {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('Workbook has no sheets');
  const sheet = wb.Sheets[sheetName];

  // header: 1 -> array-of-arrays so we can read headers + rows separately
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (!aoa.length) throw new Error('Sheet is empty');

  const headerRow = aoa[0].map((h, i) => (String(h || '').trim() || `Column ${i + 1}`));
  const dataRows = aoa.slice(1).filter((r) => r.some((c) => c !== '' && c !== null));

  // Build column metadata from the first non-empty sample in each column
  const columns = headerRow.map((name, idx) => {
    let sample;
    for (const r of dataRows) {
      if (r[idx] !== '' && r[idx] !== null && r[idx] !== undefined) {
        sample = r[idx];
        break;
      }
    }
    return {
      fieldName: name,
      fieldType: inferType(sample),
      markEligible: false,
      maxMarks: 0,
      options: [],
      hint: '',
    };
  });

  // Build a small preview (first 5 rows) keyed by fieldName for the UI
  const preview = dataRows.slice(0, 5).map((row) => {
    const obj = {};
    headerRow.forEach((name, idx) => {
      const v = row[idx];
      obj[name] = v instanceof Date ? v.toISOString().substring(0, 10) : v;
    });
    return obj;
  });

  return { sheetName, columns, preview, totalRows: dataRows.length };
};

module.exports = { parseBuffer };
