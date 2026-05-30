/**
 * Convert an array of plain objects into a CSV string.
 * Values that contain commas, quotes, or newlines are properly escaped.
 */
const toCSV = (rows, columns) => {
  if (!rows || !rows.length) return '';
  const cols = columns || Object.keys(rows[0]);

  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (s.includes('"') || s.includes(',') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const head = cols.join(',');
  const body = rows.map((r) => cols.map((c) => escape(r[c])).join(',')).join('\n');
  return `${head}\n${body}`;
};

const sendCSV = (res, filename, rows, columns) => {
  const csv = toCSV(rows, columns);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.status(200).send(csv);
};

module.exports = { toCSV, sendCSV };
