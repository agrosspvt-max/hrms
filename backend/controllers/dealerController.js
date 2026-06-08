const asyncHandler = require('express-async-handler');
const XLSX   = require('xlsx');
const Dealer = require('../models/Dealer');
const { logAudit } = require('../utils/audit');

/**
 * Dealer controller -- mirrors Product's CRUD + bulk import shape.
 *
 * Phase 3 schema:
 *   firmName    business / shop name (required)
 *   place       town / city          (required)
 *   dealerName  person at the firm   (required, HR/analytics-only)
 *
 * Reads are open to any authenticated user (employee needs the
 * dropdown when filing a Farmer Record).  Writes are HR / Super Admin
 * only.  Uniqueness is per (firmName, place) -- the same firmName
 * can exist in multiple places.
 */

/** Normalise + validate an incoming body.  Empty fields throw before save. */
const normalisePayload = (body = {}, { requireAll = true } = {}) => {
  const out = {};
  if (body.firmName   !== undefined) out.firmName   = String(body.firmName).trim();
  if (body.place      !== undefined) out.place      = String(body.place).trim();
  if (body.dealerName !== undefined) out.dealerName = String(body.dealerName).trim();
  if (body.active     !== undefined) out.active     = !!body.active;
  // Mirror legacy `name` to firmName whenever firmName is touched so
  // any older code reading dealer.name keeps resolving.
  if ('firmName' in out) out.name = out.firmName;
  if (requireAll) {
    for (const k of ['firmName', 'place', 'dealerName']) {
      if (!out[k]) {
        const err = new Error(`${k} is required`);
        err.statusCode = 400;
        throw err;
      }
    }
  }
  return out;
};

// GET /api/dealers?activeOnly=true&search=raj
const listDealers = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.activeOnly === 'true') where.active = true;
  if (req.query.search) {
    const re = new RegExp(String(req.query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    where.$or = [{ firmName: re }, { place: re }, { dealerName: re }, { name: re }];
  }
  res.json(await Dealer.find(where).sort({ active: -1, firmName: 1, place: 1 }));
});

// POST /api/dealers  (HR/SA)
const createDealer = asyncHandler(async (req, res) => {
  let payload;
  try { payload = normalisePayload(req.body, { requireAll: true }); }
  catch (e) { res.status(e.statusCode || 400); throw e; }
  // Uniqueness check on (firmName, place) -- case-insensitive.
  const exists = await Dealer.findOne({
    firmName: { $regex: new RegExp(`^${payload.firmName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
    place:    { $regex: new RegExp(`^${payload.place.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
  });
  if (exists) {
    res.status(400);
    throw new Error(`A dealer with firm "${payload.firmName}" at "${payload.place}" already exists`);
  }
  const d = await Dealer.create(payload);
  logAudit(req, { action: 'dealer.create', targetType: 'Dealer', targetId: d._id, targetLabel: `${d.firmName} @ ${d.place}`, meta: { dealerName: d.dealerName } });
  res.status(201).json(d);
});

// PUT /api/dealers/:id  (HR/SA)
const updateDealer = asyncHandler(async (req, res) => {
  const d = await Dealer.findById(req.params.id);
  if (!d) { res.status(404); throw new Error('Dealer not found'); }
  let payload;
  try { payload = normalisePayload(req.body, { requireAll: false }); }
  catch (e) { res.status(e.statusCode || 400); throw e; }
  Object.assign(d, payload);
  // If firmName or place changed, guard the new compound against collisions.
  if ('firmName' in payload || 'place' in payload) {
    const dup = await Dealer.findOne({
      _id: { $ne: d._id },
      firmName: { $regex: new RegExp(`^${d.firmName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
      place:    { $regex: new RegExp(`^${d.place.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
    });
    if (dup) {
      res.status(400);
      throw new Error(`Another dealer with firm "${d.firmName}" at "${d.place}" already exists`);
    }
  }
  await d.save();
  logAudit(req, { action: 'dealer.update', targetType: 'Dealer', targetId: d._id, targetLabel: `${d.firmName} @ ${d.place}` });
  res.json(d);
});

// DELETE /api/dealers/:id  (HR/SA) -- soft-deactivate to preserve history.
const deactivateDealer = asyncHandler(async (req, res) => {
  const d = await Dealer.findById(req.params.id);
  if (!d) { res.status(404); throw new Error('Dealer not found'); }
  d.active = false;
  await d.save();
  logAudit(req, { action: 'dealer.deactivate', targetType: 'Dealer', targetId: d._id, targetLabel: `${d.firmName} @ ${d.place}` });
  res.json(d);
});

/* ============================================================
 * Bulk import (xlsx / csv) + sample download + export.
 * Header layout matches Product: a single data sheet + an
 * Instructions sheet.
 * ============================================================ */

const SAMPLE_HEADER = ['Firm Name', 'Place', 'Dealer Name'];
const SAMPLE_ROWS = [
  ['Agro Traders',      'Bhopal',  'Rajesh Sharma'],
  ['Agro Traders',      'Vidisha', 'Amit Verma'],
  ['Green Crop Centre', 'Sehore',  'Rakesh Patel'],
];
const INSTRUCTIONS_LINES = [
  ['Dealer Bulk Import — Instructions'],
  [''],
  ['• Firm Name is REQUIRED.'],
  ['• Place is REQUIRED.'],
  ['• Dealer Name is REQUIRED.'],
  ['• Upsert key = (Firm Name + Place).  Two rows with the same Firm Name but different Place are TWO separate dealers.'],
  ['• Duplicate (Firm Name + Place) rows UPDATE the existing dealer -- Dealer Name can be changed through import.'],
  ['• Rows with any blank required field are skipped.  A row-by-row error report is returned to the importer.'],
  ['• A successful import never deletes existing dealers.  To deactivate a dealer use the Dealers table.'],
  ['• The Dealers sheet is read; this Instructions sheet is ignored.'],
];

// GET /api/dealers/import-sample   (HR / SA)
const importSample = asyncHandler(async (_req, res) => {
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet([SAMPLE_HEADER, ...SAMPLE_ROWS]);
  ws1['!cols'] = [{ wch: 22 }, { wch: 14 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(wb, ws1, 'Dealers');
  const ws2 = XLSX.utils.aoa_to_sheet(INSTRUCTIONS_LINES);
  ws2['!cols'] = [{ wch: 110 }];
  XLSX.utils.book_append_sheet(wb, ws2, 'Instructions');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="dealer_import_sample.xlsx"');
  res.send(buf);
});

// GET /api/dealers/export   (HR / SA) -- full catalogue as xlsx.
const exportDealers = asyncHandler(async (_req, res) => {
  const rows = await Dealer.find({}).sort({ active: -1, firmName: 1, place: 1 }).lean();
  const aoa = [SAMPLE_HEADER, ...rows.map((d) => [d.firmName || d.name || '', d.place || '', d.dealerName || d.name || ''])];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 24 }, { wch: 14 }, { wch: 24 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Dealers');
  const ws2 = XLSX.utils.aoa_to_sheet(INSTRUCTIONS_LINES);
  ws2['!cols'] = [{ wch: 110 }];
  XLSX.utils.book_append_sheet(wb, ws2, 'Instructions');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="dealers_export_${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.send(buf);
});

/** Fuzzy header lookup -- same logic as productController.findCol. */
const normHeader = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const findCol = (headerRow, candidates) => {
  const normRow = headerRow.map(normHeader);
  for (const c of candidates) {
    const i = normRow.indexOf(normHeader(c));
    if (i >= 0) return i;
  }
  return -1;
};

// POST /api/dealers/import   (HR / SA, multer upload field name "file")
const importBulk = asyncHandler(async (req, res) => {
  if (!req.file || !req.file.buffer) {
    res.status(400); throw new Error('No file uploaded. Pick the filled sample.');
  }
  let wb;
  try { wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true }); }
  catch (e) { res.status(400); throw new Error(`Could not read uploaded file: ${e.message}`); }

  const sheetName = wb.SheetNames.includes('Dealers') ? 'Dealers' : wb.SheetNames[0];
  if (!sheetName) { res.status(400); throw new Error('Workbook has no sheets'); }
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
  if (aoa.length < 2) { res.status(400); throw new Error('Sheet has no data rows'); }

  const header = aoa[0];
  const colFirm   = findCol(header, ['Firm Name', 'firmName', 'firm']);
  const colPlace  = findCol(header, ['Place', 'city', 'location']);
  const colDealer = findCol(header, ['Dealer Name', 'dealerName', 'dealer', 'person']);

  if (colFirm   < 0) { res.status(400); throw new Error('Missing required column: Firm Name'); }
  if (colPlace  < 0) { res.status(400); throw new Error('Missing required column: Place'); }
  if (colDealer < 0) { res.status(400); throw new Error('Missing required column: Dealer Name'); }

  const dataRows = aoa.slice(1).filter((r) => r.some((c) => c !== '' && c !== null));

  // Pre-fetch every existing dealer so the upsert is one round-trip
  // per row (read = Map lookup, write = atomic).  Key = "firm|place"
  // (lowercased) so the upsert matches case-insensitively.
  const existing = await Dealer.find({}).select('_id firmName place').lean();
  const keyOf = (firm, place) => `${String(firm || '').trim().toLowerCase()}|${String(place || '').trim().toLowerCase()}`;
  const byKey = new Map(existing.map((d) => [keyOf(d.firmName, d.place), d._id]));

  let createdCount = 0;
  let updatedCount = 0;
  const failed = []; // { row, firmName, reason }

  for (let i = 0; i < dataRows.length; i++) {
    const raw = dataRows[i];
    const sheetRow = i + 2; // 1-indexed + 1 header
    const firmName   = String(raw[colFirm]   ?? '').trim();
    const place      = String(raw[colPlace]  ?? '').trim();
    const dealerName = String(raw[colDealer] ?? '').trim();

    if (!firmName)   { failed.push({ row: sheetRow, firmName: firmName || '(blank)', reason: 'Firm Name is required' });   continue; }
    if (!place)      { failed.push({ row: sheetRow, firmName,                       reason: 'Place is required' });        continue; }
    if (!dealerName) { failed.push({ row: sheetRow, firmName,                       reason: 'Dealer Name is required' });  continue; }

    try {
      const k = keyOf(firmName, place);
      const existingId = byKey.get(k);
      if (existingId) {
        await Dealer.findByIdAndUpdate(existingId, {
          firmName, place, dealerName,
          name: firmName,
          active: true,
        });
        updatedCount += 1;
      } else {
        const created = await Dealer.create({
          firmName, place, dealerName,
          name: firmName,
          active: true,
        });
        byKey.set(k, created._id);
        createdCount += 1;
      }
    } catch (e) {
      failed.push({ row: sheetRow, firmName, reason: e.message });
    }
  }

  logAudit(req, {
    action: 'dealer.bulk-import',
    targetType: 'Dealer',
    targetLabel: req.file.originalname || 'dealers.xlsx',
    meta: {
      file: req.file.originalname || 'dealers.xlsx',
      createdCount,
      updatedCount,
      failedCount: failed.length,
      totalRows: dataRows.length,
    },
  });

  res.json({
    file: req.file.originalname || 'dealers.xlsx',
    totalRows: dataRows.length,
    createdCount,
    updatedCount,
    failedCount: failed.length,
    failed,
  });
});

module.exports = {
  listDealers, createDealer, updateDealer, deactivateDealer,
  importSample, importBulk, exportDealers,
};
