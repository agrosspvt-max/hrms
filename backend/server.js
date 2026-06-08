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
app.use('/api/salary', require('./routes/salaryRoutes'));
app.use('/api/dependencies', require('./routes/dependencyRoutes'));
app.use('/api/dashboard', require('./routes/dashboardRoutes'));
app.use('/api/attendance', require('./routes/attendanceRoutes'));
app.use('/api/notifications', require('./routes/notificationRoutes'));
app.use('/api/contacts', require('./routes/contactRoutes'));
app.use('/api/events', require('./routes/eventRoutes'));
app.use('/api/holidays', require('./routes/holidayRoutes'));
app.use('/api/password-reset', require('./routes/passwordResetRoutes'));
app.use('/api/audit', require('./routes/auditRoutes'));
app.use('/api', require('./routes/productRoutes'));

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
  app.listen(PORT, () => console.log(`[server] HRMS API running on :${PORT}`));
};

start();
