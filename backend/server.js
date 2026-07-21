require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const connectDB = require('./config/db');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();

app.use(cors({ origin: process.env.CLIENT_URL || '*', credentials: true }));
app.use(express.json({ limit: '5mb' }));
if (process.env.NODE_ENV !== 'production') app.use(morgan('dev'));

// Mount routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/employees', require('./routes/employeeRoutes'));
app.use('/api/admin-accounts', require('./routes/adminAccountsRoutes'));
app.use('/api/departments', require('./routes/departmentRoutes'));
app.use('/api/designations', require('./routes/designationRoutes'));
app.use('/api/templates', require('./routes/templateRoutes'));
app.use('/api/assignments', require('./routes/assignmentRoutes'));
app.use('/api/submissions', require('./routes/submissionRoutes'));
app.use('/api/leaves', require('./routes/leaveRoutes'));
// Phase 62 -- org-wide Leave Configuration (restricted leave types
// during probation, extensible).  Existing leave workflow is untouched.
app.use('/api/leave-config', require('./routes/leaveConfigRoutes'));
// Phase 62 -- read-only Probation endpoints for dashboard/profile cards.
app.use('/api/probation', require('./routes/probationRoutes'));
app.use('/api/salary', require('./routes/salaryRoutes'));
app.use('/api/dependencies', require('./routes/dependencyRoutes'));
app.use('/api/dashboard', require('./routes/dashboardRoutes'));
app.use('/api/attendance', require('./routes/attendanceRoutes'));
// Phase 29: per-employee attendance confirmations (attendance_review mode).
app.use('/api/attendance-confirmation', require('./routes/attendanceConfirmationRoutes'));
// Phase 43: per-employee feature permissions (Manage Access → Feature Access).
app.use('/api/feature-permissions', require('./routes/featurePermissionsRoutes'));
app.use('/api/notifications', require('./routes/notificationRoutes'));
app.use('/api/contacts', require('./routes/contactRoutes'));
app.use('/api/events', require('./routes/eventRoutes'));
app.use('/api/holidays', require('./routes/holidayRoutes'));
app.use('/api/password-reset', require('./routes/passwordResetRoutes'));
app.use('/api/audit', require('./routes/auditRoutes'));
app.use('/api', require('./routes/productRoutes'));
app.use('/api/submission-control', require('./routes/submissionControlRoutes'));
app.use('/api/daily-review', require('./routes/dailyReviewRoutes'));
// Phase 69 -- Daily Self Review analytics module.  Pure read-only
// aggregation over the existing DailyReflection collection; no new
// data model, no impact on the daily-review workflow.
app.use('/api/self-review', require('./routes/dailySelfReviewRoutes'));
app.use('/api/template-analytics', require('./routes/templateAnalyticsRoutes'));
// Phase 50 — per-employee, per-day notes on the Attendance calendar.
// Independent of Tasks / Assignments / Submissions / Notifications so
// nothing else in the app is affected.
app.use('/api/attendance-notes', require('./routes/attendanceNoteRoutes'));
// Phase 61 -- Fines & Penalties module.  Automatic + manual penalty
// generation, dashboard, employee acknowledgement, analytics.
app.use('/api/penalties', require('./routes/penaltyRoutes'));
// Phase 47 — Server-Sent Events stream that pushes cross-user updates
// (notifications, leave requests, salary slips, attendance edits, etc.)
// to the affected user(s) so the UI updates without a manual refresh.
app.use('/api/realtime', require('./routes/realtimeRoutes'));
// Phase 74 -- Employee Interactions: unified HR case-management +
// searchable history of every meeting, note, warning, appreciation
// etc.  Tag catalogue lives at /api/interaction-tags.
app.use('/api/interactions',      require('./routes/interactionRoutes'));
app.use('/api/interaction-tags',  require('./routes/interactionTagRoutes'));
// Redesign: Notes knowledge-base (Personal Notes + Note Types).
// Reuses the InteractionTag catalogue + mentions autocomplete.
app.use('/api/notes',             require('./routes/noteRoutes'));
// Phase 75 (Alert-Notification-Reminder redesign, Phase 1) -- the
// compliance engine used to run inside GET /api/submissions/today.
// It now runs only via the scheduler + this explicit action endpoint
// so read handlers stay pure.
app.use('/api/compliance',        require('./routes/complianceRoutes'));
// Phase 75 Phase 2 -- Reminder + Timeline read/write surfaces.
app.use('/api/reminders',         require('./routes/reminderRoutes'));
app.use('/api/timeline',          require('./routes/timelineRoutes'));

// Phase 75 Phase 2 -- register event-bus subscribers ONCE at boot.
// Every subscriber is idempotent; publishers use services/events.
try {
  require('./services/subscribers/notificationProjector').register();
  require('./services/subscribers/reminderProjector').register();
  require('./services/subscribers/realtimeMirror').register();
} catch (e) { console.error('[events] subscriber boot error:', e.message); }

app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date() }));

/**
 * TEMPORARY debug route for diagnosing SMTP delivery on Render.
 *   GET /api/test-email?to=foo@bar.com
 *
 * Returns { success: true } on send or { success: false, error, code } on
 * failure (no auth so it can be hit with curl during deployment debug).
 * Remove once email delivery is confirmed working.
 */
app.get('/api/test-email', async (req, res) => {
  const to = (req.query.to || '').toString().trim();
  if (!to) return res.status(400).json({ success: false, error: 'Pass ?to=email@example.com' });
  try {
    const { sendMail } = require('./utils/emailService');
    const info = await sendMail({
      to,
      subject: 'HRMS SMTP test',
      text: `If you can read this, SMTP is working from ${process.env.NODE_ENV || 'unknown'} at ${new Date().toISOString()}.`,
      html: `<p>If you can read this, SMTP is working from <b>${process.env.NODE_ENV || 'unknown'}</b> at ${new Date().toISOString()}.</p>`,
    });
    return res.json({ success: true, messageId: info.messageId, response: info.response });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message,
      code: err.code || null,
      responseCode: err.responseCode || null,
      command: err.command || null,
    });
  }
});

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

/**
 * One-time data migration + index sync for the date-range payroll upgrade.
 * Legacy salary slips were keyed by (employee, month); they're backfilled
 * with a full-month payroll period so the new unique (employee, periodKey)
 * index can be built without collisions, and the stale month-unique index
 * is dropped.  Safe + idempotent to run on every boot.
 */
const syncSalaryIndexes = async () => {
  const SalarySlip = require('./models/SalarySlip');
  const { monthRange, addDays, formatYMD } = require('./utils/dateHelpers');

  const legacy = await SalarySlip.find({
    $or: [{ periodKey: { $exists: false } }, { periodKey: null }, { periodKey: '' }],
  }).select('year monthNumber month');

  for (const s of legacy) {
    let y = s.year, m = s.monthNumber;
    if ((!y || !m) && s.month) {
      const parts = String(s.month).split('-').map(Number);
      y = parts[0]; m = parts[1];
    }
    if (!y || !m) continue;
    const { from, to } = monthRange(y, m);
    const periodEnd = addDays(to, -1);
    const periodKey = `${formatYMD(from)}_${formatYMD(periodEnd)}`;
    await SalarySlip.updateOne({ _id: s._id }, { $set: { periodStart: from, periodEnd, periodKey } });
  }
  if (legacy.length) console.log(`[migrate] backfilled payroll period on ${legacy.length} legacy slip(s)`);

  // Drop the old month-unique index (if still present) then build the
  // schema-defined indexes (unique periodKey + non-unique month).
  try { await SalarySlip.collection.dropIndex('employee_1_month_1'); } catch (_) { /* already gone */ }
  try { await SalarySlip.syncIndexes(); } catch (e) { console.error('[idx] SalarySlip syncIndexes:', e.message); }
};

const start = async () => {
  await connectDB();
  try { await syncSalaryIndexes(); } catch (e) { console.error('[migrate] salary period migration failed:', e.message); }
  // Seed default Custom Assignment templates (idempotent).
  try {
    const { seedDefaultCallingTemplate, seedDefaultProductFarmerTemplate, migrateCallingDialedCalls } = require('./services/customTemplate');
    await seedDefaultCallingTemplate();
    await seedDefaultProductFarmerTemplate();
    // Backfill the new `dialedCalls` field on every historic Calling
    // Report submission so old analytics + new analytics stay
    // mathematically consistent.  Idempotent / safe to re-run.
    await migrateCallingDialedCalls();
  } catch (e) { console.error('[seed] custom template seed failed:', e.message); }
  // Stamp analyticsType=calling on existing "Marketing"-named
  // department(s) so HOD analytics tabs survive future renames.
  try {
    const { migrateDepartmentAnalyticsType } = require('./services/departmentMigration');
    await migrateDepartmentAnalyticsType();
  } catch (e) { console.error('[migrate] department analyticsType failed:', e.message); }
  // Backfill firmName + dealerName on every legacy Dealer row + swap
  // the old name-unique index for the new (firmName, place) compound.
  try {
    const { migrateDealerSchema } = require('./services/dealerMigration');
    await migrateDealerSchema();
  } catch (e) { console.error('[migrate] dealer schema failed:', e.message); }
  // Backfill DailyReflection + DailyReview from every existing
  // submission grouped by (employee, date).  Idempotent: rows that
  // already exist are skipped.  Safe to re-run on every restart.
  try {
    const { migrateDailyReviews } = require('./services/dailyReviewMigration');
    await migrateDailyReviews();
  } catch (e) { console.error('[migrate] daily-review backfill failed:', e.message); }
  // Backfill analyticsName + reviewFlow defaults on existing templates
  // so the Dynamic Analytics page renders a sensible label for every
  // historical row (idempotent).
  try {
    const { migrateTemplateAnalytics } = require('./services/templateAnalyticsMigration');
    await migrateTemplateAnalytics();
  } catch (e) { console.error('[migrate] template analytics failed:', e.message); }
  // Phase 13: copy any legacy single-id Assignment.subTemplateId into
  // the new subTemplateIds array so the daily engine + analytics can
  // rely on the array alone.  Idempotent.
  try {
    const { migrateAssignmentSubTemplateIds } = require('./services/assignmentSubTemplateMigration');
    await migrateAssignmentSubTemplateIds();
  } catch (e) { console.error('[migrate] assignment sub-template ids failed:', e.message); }
  // Backfill Attendance records for every currently-approved Leave so the
  // calendar reflects historical approvals + HR can revoke from there.
  // Idempotent / safe to re-run; never modifies HR's manual overrides.
  try {
    const { migrateApprovedLeaves } = require('./services/leaveAttendance');
    await migrateApprovedLeaves();
  } catch (e) { console.error('[migrate] leave→attendance failed:', e.message); }
  // Fire-and-forget SMTP self-check.  Result is logged for debugging;
  // never blocks the HTTP listener from coming up.
  try {
    const { verifyTransporterAtBoot } = require('./utils/emailService');
    verifyTransporterAtBoot();
  } catch (e) { console.error('[smtp] boot verify error:', e.message); }
  // Phase 64.4 Gap 1 -- kick off the system-driven daily compliance
  // scheduler.  Runs the EXISTING penaltyEngine.runDaily helper for
  // every active employee at boot and every 24 hours.  Idempotent
  // via the partial-unique indexes; safe to restart at any time.
  try {
    const { start: startCompliance } = require('./services/dailyComplianceScheduler');
    startCompliance();
  } catch (e) { console.error('[compliance-scheduler] boot error:', e.message); }
  // Compliance & Accountability v2 -- scaffold + feature-flag banner.
  // The v2 engine's registries, natural-key helpers and dates helpers
  // load here so tests / detectors can import from a single barrel.
  // Every downstream v2 behaviour is gated by its own feature flag, so
  // loading the barrel does NOT change runtime behaviour on its own.
  try {
    require('./services/compliance').logBoot();
  } catch (e) { console.error('[compliance-v2] scaffold boot error:', e.message); }
  // Phase 3 -- idempotent built-in ComplianceRule seeder.  Seeds every
  // rule with `enabled: false`, so no downstream behaviour changes even
  // when the flag is on; HR flips rules on individually from the editor.
  try {
    const { start: startRuleSeed } = require('./services/compliance/rules/ruleSeed');
    startRuleSeed();
  } catch (e) { console.error('[compliance-rules-seed] boot error:', e.message); }
  // Phase 6 -- ledger reconciler.  Nightly integrity check at 02:00
  // local; boot catch-up runs immediately.  Gated by
  // `compliance.reconciler`.
  try {
    const { start: startReconciler } = require('./services/compliance/reconciliation/ledgerReconciler');
    startReconciler();
  } catch (e) { console.error('[compliance/reconciler] boot error:', e.message); }
  // One-time normalisation: every existing employee not on
  // auto_attendance is set to attendance_review.  Idempotent + async
  // so a re-run performs zero writes and boot is never blocked.
  try {
    const { start: startAttModeMigration } = require('./services/attendanceModeMigration');
    startAttModeMigration();
  } catch (e) { console.error('[attendance-mode-migration] boot error:', e.message); }
  // Phase 65.1 -- archive any pre-rollout missed_submission /
  // absent_submission Penalty rows + hide the notifications they
  // produced.  Idempotent + async; boot is never blocked.
  try {
    const { start: startArchive } = require('./services/legacyMissedSubmissionArchive');
    startArchive();
  } catch (e) { console.error('[legacy-compliance-archive] boot error:', e.message); }
  // Phase 74 -- seed the default Employee Interactions tag catalogue.
  // Idempotent upsert-by-slug; re-runs perform zero writes once every
  // default tag exists.
  try {
    const { start: startTagSeed } = require('./services/interactionTagSeeder');
    startTagSeed();
  } catch (e) { console.error('[interaction-tag-seed] boot error:', e.message); }
  // Phase 75 Phase 2 -- reminder scheduler.  Fires alert:changed for
  // reminders that just became due; never writes a Notification.
  try {
    const { start: startReminderSched } = require('./services/reminderScheduler');
    startReminderSched();
  } catch (e) { console.error('[reminder-scheduler] boot error:', e.message); }
  app.listen(PORT, () => console.log(`[server] HRMS API running on :${PORT}`));
};

start();
