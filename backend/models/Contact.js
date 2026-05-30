const mongoose = require('mongoose');

/**
 * Contact Directory
 *
 * A company-wide work contact book.  Two kinds of entries live here:
 *
 *   - kind: 'employee'  A pointer to an existing HRMS user (linkedEmployee).
 *                       Name / phone / email / department / designation are
 *                       served live from the User record on read, so they
 *                       always stay in sync.
 *
 *   - kind: 'external'  A free-form contact for vendors, consultants, govt
 *                       contacts, etc.  Never creates a User account.
 *
 * In both cases HR adds a `scopeOfWork` describing why teammates should
 * contact this person.  This module is purely informational and does not
 * affect payroll, attendance, leaves, assignments or permissions.
 */
const contactSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['employee', 'external'], required: true, index: true },

    // Display name.  For internal contacts we copy from the user on save so
    // the directory still renders if the user is later removed.
    name: { type: String, required: true, trim: true, index: true },

    // ---- Internal contact ----
    linkedEmployee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

    // ---- External-only fields (ignored for internal) ----
    organization: { type: String, default: '', trim: true },
    contactType: { type: String, default: '', trim: true }, // e.g. Vendor / Consultant / Govt
    phone: { type: String, default: '', trim: true },
    altPhone: { type: String, default: '', trim: true },
    email: { type: String, default: '', lowercase: true, trim: true },
    roleTitle: { type: String, default: '', trim: true }, // designation / role text
    departmentText: { type: String, default: '', trim: true },
    address: { type: String, default: '', trim: true },
    notes: { type: String, default: '', trim: true },

    // ---- Common ----
    scopeOfWork: { type: String, default: '', trim: true },
    // Category drives the on-card severity badge (and lets you surface
    // emergency / critical-support contacts above the fold).
    category: {
      type: String,
      enum: ['emergency', 'critical_support', 'management', 'general'],
      default: 'general',
      index: true,
    },
    // Lightweight popularity counter used for the HR "Most Viewed" card.
    viewCount: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

contactSchema.index({ kind: 1, status: 1 });

module.exports = mongoose.model('Contact', contactSchema);
