/**
 * Read-only diagnostic for the Pallavi / 2026-07-16 hypothesis.
 *
 * NEVER writes, updates, deletes, or connects to any collection
 * outside the ones enumerated below.  Safe to run against production.
 *
 * Usage:
 *   cd backend
 *   node inspect-pallavi-2026-07-16.js
 *
 * Requires MONGO_URI in backend/.env (same file the app reads).
 */

require("dotenv").config();
const mongoose = require("mongoose");

const EMP_CODE = process.env.EMP || "AMI0016";
const DAY_ISO = process.env.DAY || "2026-07-16";

// UTC-midnight equivalent of the same-day column stored on Submission /
// Penalty.targetDate.  Matches utils/dateHelpers.startOfDay behaviour.
const dayStart = new Date(`${DAY_ISO}T00:00:00.000Z`);
const dayEnd = new Date(`${DAY_ISO}T23:59:59.999Z`);

const printJSON = (label, doc) => {
  console.log(`\n--- ${label} ---`);
  if (!doc) {
    console.log("(none)");
    return;
  }
  console.log(JSON.stringify(doc, null, 2));
};

(async () => {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI not set in backend/.env");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 8000,
  });

  const User = require("./models/User");
  const Submission = require("./models/Submission");
  const Penalty = require("./models/Penalty");
  const Assignment = require("./models/Assignment");
  const Template = require("./models/Template");
  const Attendance = require("./models/Attendance");
  const Leave = require("./models/Leave");
  const AttendanceConfirmation = require("./models/AttendanceConfirmation");

  console.log(
    `\n================================================================`
  );
  console.log(`  DB inspection -- employee ${EMP_CODE}, day ${DAY_ISO}`);
  console.log(
    `================================================================`
  );

  /* -------------------------------------------------------------- */
  /* 1. USER                                                         */
  /* -------------------------------------------------------------- */
  const user = await User.findOne({ employeeId: EMP_CODE })
    .select(
      "_id name employeeId status attendanceMode role department designation weeklyOff"
    ).lean();

  console.log(`\n============ 1. USER ============`);
  if (!user) {
    console.log(`No user found with employeeId=${EMP_CODE}`);
    await mongoose.disconnect();
    process.exit(0);
  }
  printJSON("User", {
    _id: user._id,
    name: user.name,
    employeeId: user.employeeId,
    status: user.status,
    attendanceMode: user.attendanceMode,
    role: user.role,
    department: user.department,
    designation: user.designation,
    weeklyOff: user.weeklyOff,
  });

  /* -------------------------------------------------------------- */
  /* 2. SUBMISSION -- exact-date + wide-range (defensive)             */
  /* -------------------------------------------------------------- */
  console.log(`\n============ 2. SUBMISSION ============`);
  // (a) Strict UTC-midnight match, NO filters -- see raw truth.
  const subsExact = await Submission.find({
    employee: user._id,
    date: dayStart,
  }).lean();

  // (b) Any submission whose `date` is anywhere within the day window,
  //     ignoring the storage convention.  Catches TZ-off-by-one bugs.
  const subsInDay = await Submission.find({
    employee: user._id,
    date: { $gte: dayStart, $lte: dayEnd },
  }).lean();

  console.log(
    `Exact-match (date === ${dayStart.toISOString()}): ${
      subsExact.length
    } row(s)`
  );
  console.log(
    `Range-match (${dayStart.toISOString()} .. ${dayEnd.toISOString()}): ${
      subsInDay.length
    } row(s)`
  );

  const allSubs = subsInDay.length ? subsInDay : subsExact;
  if (allSubs.length === 0) {
    console.log("\nNo Submission exists for this employee/day.");
  } else {
    allSubs.forEach((s, i) => {
      printJSON(`Submission[${i}]`, {
        _id: s._id,
        employee: s.employee,
        date: s.date,
        assignment: s.assignment,
        template: s.template,
        templateType: s.templateType,
        submitted: s.submitted,
        submittedAt: s.submittedAt,
        lastDraftSavedAt: s.lastDraftSavedAt,
        deleted: s.deleted,
        deletedAt: s.deletedAt,
        deletedBy: s.deletedBy,
        deleteReason: s.deleteReason,
        isTestData: s.isTestData,
        currentReviewStage: s.currentReviewStage,
        hodReviewRecommend: s.hodReview?.recommend || "",
        holidayOverride: s.holidayOverride,
        overrideReason: s.overrideReason,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      });
    });
  }

  /* -------------------------------------------------------------- */
  /* 3. PENALTY                                                      */
  /* -------------------------------------------------------------- */
  console.log(`\n============ 3. PENALTY ============`);
  const pens = await Penalty.find({
    employee: user._id,
    targetDate: { $gte: dayStart, $lte: dayEnd },
  }).lean();
  console.log(
    `Penalties for targetDate in [${dayStart.toISOString()} .. ${dayEnd.toISOString()}]: ${
      pens.length
    }`
  );
  pens.forEach((p, i) => {
    printJSON(`Penalty[${i}]`, {
      _id: p._id,
      category: p.category,
      submission: p.submission,
      status: p.status,
      source: p.source,
      probable: p.probable,
      rule: p.rule,
      targetDate: p.targetDate,
      penaltyMarks: p.penaltyMarks,
      archivedPreRollout: p.archivedPreRollout,
      reopenRequest: p.reopenRequest,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    });
  });

  /* -------------------------------------------------------------- */
  /* 4. ASSIGNMENT (via each Submission's FK)                        */
  /* -------------------------------------------------------------- */
  console.log(`\n============ 4. ASSIGNMENT ============`);
  const assignmentIds = [
    ...new Set([
      ...allSubs.map((s) => String(s.assignment || "")).filter(Boolean),
      ...pens.map((p) => String(p.submission || "")).filter(Boolean), // via Submission below
    ]),
  ];
  const distinctAssignmentIds = [
    ...new Set(allSubs.map((s) => String(s.assignment || "")).filter(Boolean)),
  ];
  console.log(
    `Distinct assignment IDs referenced by Submission stubs: ${distinctAssignmentIds.length}`
  );

  for (const aid of distinctAssignmentIds) {
    const a = await Assignment.findById(aid).lean();
    if (!a) {
      printJSON(`Assignment ${aid}`, {
        MISSING: true,
        reason: "assignment document was deleted",
      });
      continue;
    }
    printJSON(`Assignment ${aid}`, {
      _id: a._id,
      template: a.template,
      targetType: a.targetType,
      targetRef: a.targetRef,
      frequency: a.frequency,
      startDate: a.startDate,
      endDate: a.endDate,
      active: a.active,
      revokedAt: a.revokedAt,
      holidayOverride: a.holidayOverride,
      overrideScope: a.overrideScope,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    });
  }

  /* -------------------------------------------------------------- */
  /* 5. TEMPLATE                                                     */
  /* -------------------------------------------------------------- */
  console.log(`\n============ 5. TEMPLATE ============`);
  const templateIds = [
    ...new Set(allSubs.map((s) => String(s.template || "")).filter(Boolean)),
  ];
  for (const tid of templateIds) {
    const t = await Template.findById(tid)
      .select("_id title templateType customKind isActive createdAt updatedAt")
      .lean();
    if (!t) {
      printJSON(`Template ${tid}`, {
        MISSING: true,
        reason: "template document was deleted",
      });
      continue;
    }
    printJSON(`Template ${tid}`, t);
  }

  /* -------------------------------------------------------------- */
  /* 6. OVERLAY DATA -- Leave / Attendance / Confirmation            */
  /*    (context only -- helps interpret the trace)                  */
  /* -------------------------------------------------------------- */
  console.log(`\n============ 6. OVERLAYS ============`);
  const leave = await Leave.findOne({
    employee: user._id,
    status: "approved",
    fromDate: { $lte: dayEnd },
    toDate: { $gte: dayStart },
  }).lean();
  printJSON("Approved Leave overlapping day", leave);

  const att = await Attendance.findOne({
    employee: user._id,
    date: dayStart,
  }).lean();
  printJSON("Attendance row", att);

  const conf = await AttendanceConfirmation.findOne({
    employee: user._id,
    date: dayStart,
  }).lean();
  printJSON("AttendanceConfirmation row", conf);

  /* -------------------------------------------------------------- */
  /* 7. RELATIONSHIP CHAIN                                           */
  /* -------------------------------------------------------------- */
  console.log(`\n============ 7. RELATIONSHIP CHAIN ============`);
  const submissionExists = allSubs.length > 0;
  const primarySub = allSubs[0] || null;
  const primaryAssignmentId = primarySub
    ? String(primarySub.assignment || "")
    : "";
  const primaryTemplateId = primarySub ? String(primarySub.template || "") : "";
  const assignmentDoc = primaryAssignmentId
    ? await Assignment.findById(primaryAssignmentId).lean()
    : null;
  const templateDoc = primaryTemplateId
    ? await Template.findById(primaryTemplateId).select("_id").lean()
    : null;

  const chain = {
    "User exists": !!user,
    'User.status === "active"': user.status === "active",
    'User.attendanceMode !== "auto_attendance"':
      user.attendanceMode !== "auto_attendance",
    "Submission exists": submissionExists,
    "Submission.deleted !== true": primarySub
      ? primarySub.deleted !== true
      : null,
    "Submission.isTestData !== true": primarySub
      ? primarySub.isTestData !== true
      : null,
    "Submission.submitted": primarySub ? primarySub.submitted : null,
    "Submission.assignment FK still resolves": primaryAssignmentId
      ? !!assignmentDoc
      : null,
    "Assignment.active": assignmentDoc ? assignmentDoc.active : null,
    "Assignment.revokedAt": assignmentDoc ? assignmentDoc.revokedAt : null,
    "Submission.template FK still resolves": primaryTemplateId
      ? !!templateDoc
      : null,
    "Any Penalty for the day": pens.length > 0,
    "Any Penalty FK matches a Submission._id present today": pens.some((p) =>
      allSubs.some((s) => String(s._id) === String(p.submission))
    ),
  };
  console.log(JSON.stringify(chain, null, 2));

  /* -------------------------------------------------------------- */
  /* 8. FIRST DIVERGING DOCUMENT                                     */
  /* -------------------------------------------------------------- */
  console.log(`\n============ 8. FIRST DIFF FROM EXPECTATION ============`);
  const problems = [];
  if (user.status !== "active")
    problems.push(
      `User.status = "${user.status}"  (expected "active" -- excluded at empWhere.status filter)`
    );
  if (user.attendanceMode === "auto_attendance")
    problems.push(
      `User.attendanceMode = "auto_attendance"  (excluded at empWhereNS.attendanceMode filter, dailyReviewController.js:450)`
    );
  if (!submissionExists)
    problems.push(
      `No Submission stub exists for (employee, date).  dayStubs is empty -> hasAssignments = false -> eligible = false.`
    );
  if (submissionExists && primarySub.deleted === true)
    problems.push(
      `Submission.deleted = true  (filtered by liveSubmissionFilter, dailyReviewController.js:707)`
    );
  if (submissionExists && primarySub.isTestData === true)
    problems.push(
      `Submission.isTestData = true  (filtered by liveSubmissionFilter, dailyReviewController.js:707)`
    );
  if (submissionExists && primarySub.submitted === true)
    problems.push(
      `Submission.submitted = true  (missedStubs empty -> eligible = false)`
    );
  if (submissionExists && primaryAssignmentId && !assignmentDoc)
    problems.push(
      `Assignment ${primaryAssignmentId} missing (stub carries dangling FK).  Membership still fires (Submission is truth), display falls back to stub.template.`
    );
  if (submissionExists && primaryTemplateId && !templateDoc)
    problems.push(
      `Template ${primaryTemplateId} missing.  Card title falls back to "(untitled)".`
    );
  if (pens.length === 0)
    problems.push(
      `No missed_submission Penalty for the day (previous assertion "she has a penalty" would be false in this data).`
    );

  if (problems.length === 0) {
    console.log(
      "No divergence detected.  If the page still does not show her, the discrepancy is upstream of the DB (query date, role scope, or feature permission)."
    );
  } else {
    problems.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  }

  await mongoose.disconnect();
})().catch(async (e) => {
  console.error("inspection failed:", (e && e.stack) || e);
  try {
    await mongoose.disconnect();
  } catch (_) {
    /* noop */
  }
  process.exit(1);
});
