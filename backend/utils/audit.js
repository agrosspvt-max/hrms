const AuditLog = require('../models/AuditLog');

/**
 * Fire-and-forget audit logger.  Never throws back to the caller - if
 * the log write fails it's logged to the console and the original
 * controller flow continues.
 */
const logAudit = (req, payload) => {
  const doc = {
    actor: req.user?._id,
    actorRole: req.user?.role,
    action: payload.action,
    targetType: payload.targetType || '',
    targetId: payload.targetId,
    targetLabel: payload.targetLabel || '',
    meta: payload.meta || {},
    ip: req.ip,
  };
  AuditLog.create(doc).catch((err) => {
    console.error('[audit] failed to write log:', err.message, doc);
  });
};

module.exports = { logAudit };
