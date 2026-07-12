const mongoose = require('mongoose');

/**
 * LeaveConfig  --  Phase 62 org-wide Leave Configuration singleton.
 *
 * The Leave module itself is untouched.  This collection carries
 * settings that sit ALONGSIDE the existing pipeline -- currently
 * just the list of leave types restricted during an employee's
 * probation window.  Kept as its own document so future config
 * fields (holiday allowlists, cutoff rules, etc.) can slot in
 * without touching the User or Leave schemas.
 *
 * There is exactly ONE document at any time.  The controller uses
 * an upsert on `{ singleton: true }` so callers never have to know
 * an id.
 *
 * Defaults follow the spec's example ("Restricted During Probation:
 * ✓ Paid Leave") -- Paid Leave is restricted unless HR changes it.
 */
const leaveConfigSchema = new mongoose.Schema(
  {
    // Fixed marker for the singleton row.  Unique index enforces it.
    singleton: { type: Boolean, default: true, unique: true, index: true },

    // Array of Leave.leaveType enum values that should be BLOCKED
    // while the employee is on probation.  Empty array = no
    // restriction (probation acts as informational only).
    restrictedDuringProbation: {
      type: [String],
      default: ['paid'],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('LeaveConfig', leaveConfigSchema);
