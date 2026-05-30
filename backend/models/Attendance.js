const mongoose = require('mongoose');

/**
 * Attendance - an EXPLICIT per-day attendance record for one employee.
 *
 * Most days don't need a record: deriveAttendance() infers present /
 * absent / leave / weekly-off / holiday from submissions + leaves.  A
 * record is written only when the day deviates from that, namely:
 *
 *   - source 'auto'   : the system detected a half-day at submission time
 *                       (submitted before the half-day cutoff).
 *   - source 'manual' : HR explicitly overrode the day's status.
 *
 * When a record exists it OVERRIDES the derived status.  A manual record
 * always wins over an auto one.
 *
 * status values map 1:1 to the salary / leave effects:
 *   present       -> paid full day,        no leave used
 *   half_paid     -> paid full day,        0.5 leave used (arranged half-leave)
 *   half_unpaid   -> 0.5 day salary cut,   no leave used
 *   full_paid     -> paid full day,        1 leave used
 *   full_unpaid   -> full day salary cut,  no leave used
 *   absent        -> full day salary cut,  no leave used
 *   weekly_off    -> no deduction,         no leave used
 */
const attendanceSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // UTC midnight of the day this record applies to.
    date: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: ['present', 'half_paid', 'half_unpaid', 'full_paid', 'full_unpaid', 'absent', 'weekly_off'],
      required: true,
    },
    source: { type: String, enum: ['auto', 'manual'], default: 'manual' },
    note: { type: String, default: '', trim: true },
    setBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // Leave-balance units this record itself consumed (half_paid -> 0.5,
    // full_paid -> 1, everything else -> 0).  Tracked so that editing or
    // clearing a MANUAL override can reverse exactly what it applied,
    // keeping leaveBalance.used consistent without double-counting.
    leaveDelta: { type: Number, default: 0 },
  },
  { timestamps: true }
);

attendanceSchema.index({ employee: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('Attendance', attendanceSchema);
