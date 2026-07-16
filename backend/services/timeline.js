/**
 * timeline.js -- derived Activity Timeline.
 *
 * The Timeline is a READ-ONLY union query over existing entities.
 * We deliberately don't have a `TimelineEntry` collection (see
 * docs/ADR/ADR-004): the source-of-truth entity is the timeline
 * row.  This service normalises rows into a common shape, sorts,
 * paginates, and offers a full-text search across denormalised
 * fields.
 *
 * If the union ever gets slow (unlikely at our scale), swap the
 * implementation of `collect()` for a projection subscribed to
 * events.publish -- every caller keeps working.
 */
const mongoose = require('mongoose');

const Submission             = require('../models/Submission');
const Penalty                = require('../models/Penalty');
const Leave                  = require('../models/Leave');
const SalarySlip             = require('../models/SalarySlip');
const Interaction            = require('../models/Interaction');
const InteractionNote        = require('../models/InteractionNote');
const AttendanceConfirmation = require('../models/AttendanceConfirmation');
const Reminder               = require('../models/Reminder');

const deepLinkFor = ({ entityType, entityId }) => {
  if (!entityType || !entityId) return '';
  switch (entityType) {
    case 'submission':   return `/submissions/${entityId}`;
    case 'penalty':      return `/penalties?open=${entityId}`;
    case 'leave':        return `/my-leaves?open=${entityId}`;
    case 'salary_slip':  return `/my-salary?open=${entityId}`;
    case 'interaction':  return `/interactions?open=${entityId}`;
    case 'attendance':   return `/my-attendance`;
    case 'reminder':     return '/'; // dashboard widget already shows it
    default:             return '';
  }
};

const _mkRow = ({ occurredAt, entityType, entityId, title, summary = '',
                  icon = '', color = '', actor = null, meta = {} }) => ({
  occurredAt,
  entityType,
  entityId,
  title,
  summary,
  icon,
  color,
  actor,
  sourceRef: { module: entityType, id: entityId },
  deepLink: deepLinkFor({ entityType, entityId }),
  meta,
});

/**
 * Pull each entity type in the [from, to] window for a subject and
 * normalise to the timeline row shape.  Every projection is a
 * `find().lean()` -- no N+1.
 */
const collect = async ({ subject, from, to, types }) => {
  const subjId = new mongoose.Types.ObjectId(String(subject));
  const inRange = (fromField, toField) => {
    const r = {};
    if (from) r[fromField] = { $lte: to };
    if (to)   r[toField]   = { $gte: from };
    return r;
  };
  const dateBetween = { $gte: from, $lte: to };
  const rowsPerType = {};

  const wants = (t) => !types || types.length === 0 || types.includes(t);

  // ---- Submissions --------------------------------------------------
  if (wants('submission')) {
    const subs = await Submission.find({
      employee: subjId,
      $or: [{ submittedAt: dateBetween }, { reviewedAt: dateBetween }],
    }).select('_id date submittedAt reviewedAt submitted reviewStatus template templateType')
      .populate('template', 'title').lean();
    const rows = [];
    for (const s of subs) {
      if (s.submittedAt && s.submittedAt >= from && s.submittedAt <= to) {
        rows.push(_mkRow({
          occurredAt: s.submittedAt,
          entityType: 'submission', entityId: s._id,
          title: 'Submission filed',
          summary: s.template?.title || 'Daily submission',
          icon: '📤', color: '#3b82f6',
          meta: { templateType: s.templateType, date: s.date },
        }));
      }
      if (s.reviewedAt && s.reviewedAt >= from && s.reviewedAt <= to) {
        rows.push(_mkRow({
          occurredAt: s.reviewedAt,
          entityType: 'submission', entityId: s._id,
          title: 'Submission reviewed',
          summary: `${s.template?.title || 'Submission'} · ${s.reviewStatus || 'reviewed'}`,
          icon: '✔', color: '#16a34a',
          meta: { reviewStatus: s.reviewStatus },
        }));
      }
    }
    rowsPerType.submission = rows;
  }

  // ---- Penalties ----------------------------------------------------
  if (wants('penalty')) {
    const rows = [];
    const pens = await Penalty.find({
      employee: subjId,
      $or: [{ effectiveDate: dateBetween }, { resolvedAt: dateBetween }, { cancelledAt: dateBetween }],
    }).select('_id category effectiveDate resolvedAt cancelledAt reason employeeMessage financialStatus penaltyMarks').lean();
    for (const p of pens) {
      if (p.effectiveDate && p.effectiveDate >= from && p.effectiveDate <= to) {
        rows.push(_mkRow({
          occurredAt: p.effectiveDate,
          entityType: 'penalty', entityId: p._id,
          title: 'Penalty applied',
          summary: p.employeeMessage || p.reason || p.category,
          icon: '⚠', color: '#ef4444',
          meta: { category: p.category, marks: p.penaltyMarks || 0 },
        }));
      }
      if (p.resolvedAt && p.resolvedAt >= from && p.resolvedAt <= to) {
        rows.push(_mkRow({
          occurredAt: p.resolvedAt,
          entityType: 'penalty', entityId: p._id,
          title: 'Penalty resolved',
          summary: p.reason || p.category,
          icon: '✅', color: '#16a34a',
          meta: { category: p.category },
        }));
      }
      if (p.cancelledAt && p.cancelledAt >= from && p.cancelledAt <= to) {
        rows.push(_mkRow({
          occurredAt: p.cancelledAt,
          entityType: 'penalty', entityId: p._id,
          title: 'Penalty cancelled',
          summary: p.reason || p.category,
          icon: '🚫', color: '#94a3b8',
          meta: { category: p.category },
        }));
      }
    }
    rowsPerType.penalty = rows;
  }

  // ---- Leaves -------------------------------------------------------
  if (wants('leave')) {
    const rows = [];
    const lvs = await Leave.find({
      employee: subjId,
      $or: [{ createdAt: dateBetween }, { decidedAt: dateBetween }],
    }).select('_id status leaveType fromDate toDate createdAt decidedAt reason paid').lean();
    for (const lv of lvs) {
      if (lv.createdAt && lv.createdAt >= from && lv.createdAt <= to) {
        rows.push(_mkRow({
          occurredAt: lv.createdAt,
          entityType: 'leave', entityId: lv._id,
          title: 'Leave applied',
          summary: `${lv.leaveType || 'leave'} · ${String(lv.fromDate).slice(0,10)} → ${String(lv.toDate).slice(0,10)}`,
          icon: '🌴', color: '#0ea5e9',
          meta: { status: lv.status, paid: lv.paid },
        }));
      }
      if (lv.decidedAt && lv.decidedAt >= from && lv.decidedAt <= to) {
        rows.push(_mkRow({
          occurredAt: lv.decidedAt,
          entityType: 'leave', entityId: lv._id,
          title: `Leave ${lv.status}`,
          summary: `${lv.leaveType || 'leave'} · ${lv.status}`,
          icon: lv.status === 'approved' ? '✔' : '✖',
          color: lv.status === 'approved' ? '#16a34a' : '#ef4444',
          meta: { status: lv.status },
        }));
      }
    }
    rowsPerType.leave = rows;
  }

  // ---- Salary slips -------------------------------------------------
  if (wants('salary_slip')) {
    const rows = [];
    const slips = await SalarySlip.find({
      employee: subjId,
      createdAt: dateBetween,
    }).select('_id createdAt periodKey month netPay').lean();
    for (const s of slips) {
      rows.push(_mkRow({
        occurredAt: s.createdAt,
        entityType: 'salary_slip', entityId: s._id,
        title: 'Salary slip generated',
        summary: s.periodKey || s.month || 'Salary slip',
        icon: '💰', color: '#eab308',
        meta: { netPay: s.netPay },
      }));
    }
    rowsPerType.salary_slip = rows;
  }

  // ---- Meetings / Interactions --------------------------------------
  if (wants('interaction')) {
    const rows = [];
    const inters = await Interaction.find({
      'participants.employee': subjId,
      createdAt: dateBetween,
    }).select('_id createdAt type title description createdBy meeting.date').populate('createdBy', 'name').lean();
    for (const i of inters) {
      rows.push(_mkRow({
        occurredAt: i.createdAt,
        entityType: 'interaction', entityId: i._id,
        title: `${i.type} recorded`,
        summary: i.title,
        icon: i.type === 'meeting' ? '📅' : '📝',
        color: '#6366f1',
        actor: i.createdBy ? { _id: i.createdBy._id, name: i.createdBy.name } : null,
        meta: { type: i.type },
      }));
    }
    // Notes attached to interactions the subject is part of.
    const intIds = inters.map((i) => i._id);
    if (intIds.length) {
      const notes = await InteractionNote.find({
        interaction: { $in: intIds }, createdAt: dateBetween,
      }).select('_id createdAt author body interaction').populate('author', 'name').lean();
      for (const n of notes) {
        rows.push(_mkRow({
          occurredAt: n.createdAt,
          entityType: 'interaction', entityId: n.interaction,
          title: 'Note added to interaction',
          summary: (n.body || '').slice(0, 200),
          icon: '🗒', color: '#8b5cf6',
          actor: n.author ? { _id: n.author._id, name: n.author.name } : null,
        }));
      }
    }
    rowsPerType.interaction = rows;
  }

  // ---- Attendance confirmations ------------------------------------
  if (wants('attendance')) {
    const rows = [];
    const cfs = await AttendanceConfirmation.find({
      employee: subjId,
      $or: [{ confirmedAt: dateBetween }, { reviewedAt: dateBetween }],
    }).select('_id confirmedAt reviewedAt status').lean();
    for (const c of cfs) {
      if (c.confirmedAt && c.confirmedAt >= from && c.confirmedAt <= to) {
        rows.push(_mkRow({
          occurredAt: c.confirmedAt,
          entityType: 'attendance', entityId: c._id,
          title: 'Attendance confirmed',
          summary: 'Confirmed present for the day',
          icon: '🟢', color: '#22c55e',
        }));
      }
      if (c.reviewedAt && c.reviewedAt >= from && c.reviewedAt <= to) {
        rows.push(_mkRow({
          occurredAt: c.reviewedAt,
          entityType: 'attendance', entityId: c._id,
          title: 'Attendance reviewed',
          summary: `HR set: ${c.status}`,
          icon: '👁', color: '#0ea5e9',
          meta: { status: c.status },
        }));
      }
    }
    rowsPerType.attendance = rows;
  }

  // ---- Reminder completions ----------------------------------------
  if (wants('reminder')) {
    const rows = [];
    const rems = await Reminder.find({
      recipient: subjId,
      completedAt: dateBetween,
    }).select('_id completedAt actionKind title targetRoute').lean();
    for (const r of rems) {
      rows.push(_mkRow({
        occurredAt: r.completedAt,
        entityType: 'reminder', entityId: r._id,
        title: 'Reminder completed',
        summary: r.title || r.actionKind,
        icon: '✅', color: '#22c55e',
        meta: { actionKind: r.actionKind },
      }));
    }
    rowsPerType.reminder = rows;
  }

  return rowsPerType;
};

/**
 * Public API used by the controller.  Filters + paginates in-memory
 * because the union across all six sources is already bounded by
 * (subject, date range) -- at our scale this is trivial.
 */
const getFor = async ({ subject, from, to, types, search, page = 1, perPage = 40 }) => {
  const _from = new Date(from);
  const _to   = new Date(to);
  const perType = await collect({ subject, from: _from, to: _to, types });
  let rows = Object.values(perType).flat();

  if (search) {
    const q = String(search).toLowerCase();
    rows = rows.filter((r) =>
      (r.title || '').toLowerCase().includes(q) ||
      (r.summary || '').toLowerCase().includes(q) ||
      (r.actor?.name || '').toLowerCase().includes(q) ||
      (r.meta?.category || '').toLowerCase().includes(q));
  }
  rows.sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));

  const total = rows.length;
  const start = (page - 1) * perPage;
  const paged = rows.slice(start, start + perPage);
  return { rows: paged, total, page, perPage, totalPages: Math.max(1, Math.ceil(total / perPage)) };
};

module.exports = { getFor, deepLinkFor };
