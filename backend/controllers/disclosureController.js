const asyncHandler = require('express-async-handler');
const svc = require('../services/disclosure');
const { logAudit } = require('../utils/audit');

// Map service errors onto the project's res.status + throw convention.
const _wrap = (fn) => asyncHandler(async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e instanceof svc.DisclosureError) res.status(e.status);
    throw e;
  }
});

/** POST /api/disclosures -- employee files / updates THEIR OWN disclosure for a day. */
const saveMine = _wrap(async (req, res) => {
  const { doc, previous, created } = await svc.saveForEmployee({ actor: req.user, body: req.body || {} });
  logAudit(req, {
    action: created ? 'disclosure.create' : 'disclosure.update',
    targetType: 'Disclosure',
    targetId: doc._id,
    targetLabel: `${req.user.name || req.user._id} · ${new Date(doc.date).toISOString().slice(0, 10)} · ${doc.type}`,
    meta: {
      submissionId: String(doc.submission),
      // Previous values are preserved in the audit trail on every change.
      previous,
      next: { type: doc.type, details: doc.details, correctable: doc.correctable, corrected: doc.corrected, authorizedBy: doc.authorizedBy },
    },
  });
  res.status(created ? 201 : 200).json(doc);
});

/** GET /api/disclosures/mine?date= -- employee reads their own record (null when none). */
const getMine = _wrap(async (req, res) => {
  res.json(await svc.getForEmployee({ employeeId: req.user._id, date: req.query.date }) || null);
});

/** GET /api/disclosures?date=&from=&to=&employee=&type=&page=&limit=  (HR / Super Admin) */
const list = _wrap(async (req, res) => {
  res.json(await svc.list(req.query || {}));
});

module.exports = { saveMine, getMine, list };
