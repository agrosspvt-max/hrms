/**
 * refileController.js -- HTTP layer of the Compliance re-file grant.
 *
 *   POST /api/compliance/refile/requests               employee: request to re-file own missed day
 *   GET  /api/compliance/refile/requests?status=       HR/SA: all; employee: own
 *   POST /api/compliance/refile/requests/:id/decide    HR/SA: { decision, note?, evaluationMode? }
 *   POST /api/compliance/refile/requests/:id/revoke    HR/SA: { reason? }
 *   POST /api/compliance/refile/send-back              HR/SA: { submissionId | employeeId+date, note?, evaluationMode? }
 *
 * Authorization is enforced in the service (it is the single place that knows
 * the rules); handlers only gate on the feature flag and translate errors.
 */
const asyncHandler = require('express-async-handler');
const { isEnabled } = require('../../config/featureFlags');
const refile = require('../../services/compliance/refile/refileService');

const _gate = (res) => {
  if (!isEnabled('compliance.waiverRecovery')) { res.status(404); throw new Error('Compliance re-file is not enabled on this deployment.'); }
};
const _run = async (res, fn) => {
  try { return await fn(); } catch (e) { res.status(e.httpStatus || 400); throw e; }
};

const create = asyncHandler(async (req, res) => {
  _gate(res);
  const row = await _run(res, () => refile.request({ user: req.user, submissionId: req.body && req.body.submissionId, reason: req.body && req.body.reason, req }));
  res.status(row.alreadyRequested ? 200 : 201).json(row);
});

const list = asyncHandler(async (req, res) => {
  _gate(res);
  res.json(await refile.list({ user: req.user, status: req.query && req.query.status, limit: req.query && req.query.limit }));
});

const decide = asyncHandler(async (req, res) => {
  _gate(res);
  const b = req.body || {};
  res.json(await _run(res, () => refile.decide({ refileId: req.params.id, decision: b.decision, note: b.note, evaluationMode: b.evaluationMode, actor: req.user, req })));
});

const revoke = asyncHandler(async (req, res) => {
  _gate(res);
  res.json(await _run(res, () => refile.revoke({ refileId: req.params.id, reason: req.body && req.body.reason, actor: req.user, req })));
});

const sendBack = asyncHandler(async (req, res) => {
  _gate(res);
  const b = req.body || {};
  res.json(await _run(res, () => refile.sendBack({ submissionId: b.submissionId, employeeId: b.employeeId, date: b.date, note: b.note, evaluationMode: b.evaluationMode, actor: req.user, req })));
});

module.exports = { create, list, decide, revoke, sendBack };
