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

app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date() }));

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
  app.listen(PORT, () => console.log(`[server] HRMS API running on :${PORT}`));
};

start();
