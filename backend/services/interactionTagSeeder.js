/**
 * Idempotent boot-time seed for the default InteractionTag catalogue.
 * Uses upserts keyed by `slug` so a re-run is a zero-write no-op.
 */
const InteractionTag = require('../models/InteractionTag');

const DEFAULTS = [
  // Performance
  { name: 'Excellent Work',      category: 'performance', color: '#16a34a' },
  { name: 'Needs Improvement',   category: 'performance', color: '#f59e0b' },
  { name: 'Innovation',          category: 'performance', color: '#8b5cf6' },
  { name: 'Leadership',          category: 'performance', color: '#0ea5e9' },
  { name: 'Target Achieved',     category: 'performance', color: '#22c55e' },
  { name: 'Late Submission',     category: 'performance', color: '#f97316' },
  // Behaviour
  { name: 'Misinformation',      category: 'behaviour',   color: '#ef4444', countsAsWarning: true, severity: 'high' },
  { name: 'Positive Attitude',   category: 'behaviour',   color: '#22c55e' },
  { name: 'Negative Behaviour',  category: 'behaviour',   color: '#ef4444', countsAsWarning: true, severity: 'high' },
  { name: 'Team Player',         category: 'behaviour',   color: '#0ea5e9' },
  { name: 'Conflict',            category: 'behaviour',   color: '#f97316', severity: 'medium' },
  { name: 'Communication',       category: 'behaviour',   color: '#6366f1' },
  // Compliance
  { name: 'Warning',             category: 'compliance',  color: '#ef4444', countsAsWarning: true, severity: 'high' },
  { name: 'Fine',                category: 'compliance',  color: '#dc2626', countsAsWarning: true, severity: 'high' },
  { name: 'Policy Violation',    category: 'compliance',  color: '#dc2626', countsAsWarning: true, severity: 'critical' },
  { name: 'Attendance Issue',    category: 'compliance',  color: '#f97316', countsAsWarning: true, severity: 'medium' },
  { name: 'Repeated Offence',    category: 'compliance',  color: '#7f1d1d', countsAsWarning: true, severity: 'critical' },
  // HR
  { name: 'Training',            category: 'hr',          color: '#8b5cf6' },
  { name: 'Promotion',           category: 'hr',          color: '#22c55e' },
  { name: 'Salary Discussion',   category: 'hr',          color: '#f59e0b' },
  { name: 'Probation',           category: 'hr',          color: '#0ea5e9' },
  { name: 'Follow-up',           category: 'hr',          color: '#6366f1' },
  { name: 'Recognition',         category: 'hr',          color: '#16a34a' },
];

const _slug = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

const seedInteractionTags = async () => {
  try {
    for (const t of DEFAULTS) {
      const slug = _slug(t.name);
      await InteractionTag.updateOne(
        { slug },
        {
          $setOnInsert: {
            name: t.name,
            slug,
            category: t.category,
            color: t.color,
            severity: t.severity || 'info',
            countsAsWarning: !!t.countsAsWarning,
            countsInAnalytics: true,
            visibleToEmployee: false,
            archived: false,
          },
        },
        { upsert: true },
      );
    }
  } catch (e) {
    console.error('[interaction-tag-seed] failed:', e.message);
  }
};

const start = () => { setImmediate(() => seedInteractionTags().catch(() => {})); };

module.exports = { seedInteractionTags, start };
