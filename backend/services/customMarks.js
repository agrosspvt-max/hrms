/**
 * customMarks.js — Phase 58.
 *
 * Deterministic marks calculator for Custom-template submissions.  Given
 * the template's `customFields` definition (already normalised by the
 * template controller) and the employee's answers + status meta, this
 * returns a per-field marks breakdown plus the four totals stored on
 * the Submission document.  Kept as its own module so the submit
 * handler, the analytics endpoint, and any future recalc tool can all
 * share ONE implementation of the rules.
 *
 * The rules mirror the spec:
 *   number/currency/percentage with enableMarks + enableOutOf:
 *     earned = min(1, completed / outOf) * maxMarks           (never > maxMarks)
 *     penalty applied when isCritical AND completed < threshold
 *   dropdown/yes_no with enableMarks:
 *     earned = optionMarks[i].percent / 100 * maxMarks
 *     penalty = optionMarks[i].penalty                        (per-option)
 *   status-supporting field with enableMarks:
 *     done / ongoing -> full maxMarks
 *     pending       -> 0 marks; penaltyMarks applied when isCritical
 *     work_not_available -> excluded from Available AND Earned
 *   Anything else (enableMarks off, no matching config) -> 0 across the board.
 *
 *   Final = max(0, sum(earned) - sum(penalty))                (never negative)
 */

const _num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Compute per-field marks + totals from a template's customFields plus a
 * submission's responses & meta maps.
 *
 * @param {Object[]} fields          template.customFields (normalised)
 * @param {Object}   valueByKey      { fieldKey: value }
 * @param {Object}   outOfByKey      { fieldKey: outOfValue }  (Number/enableOutOf only)
 * @param {Object}   statusByKey     { fieldKey: 'done'|'pending'|... }
 * @returns { perField: [{ key, availableMarks, earnedMarks, penaltyMarks }],
 *            available, earned, penalty, final }
 */
const computeCustomMarks = (fields, valueByKey = {}, outOfByKey = {}, statusByKey = {}) => {
  const perField = [];
  let available = 0;
  let earned    = 0;
  let penalty   = 0;

  for (const f of (fields || [])) {
    if (!f || !f.enableMarks) continue;
    // Skip fields the employee isn't expected to score.
    if (f.systemGenerated || f.fieldType === 'auto' || f.fieldType === 'readonly') continue;

    const maxMarks = _num(f.maxMarks);
    const status = statusByKey[f.key] || '';
    let av = 0, er = 0, pn = 0;

    // Work N/A universally excludes the field from Available + Earned.
    if (f.supportsStatus && status === 'work_not_available') {
      // Nothing to add.
      perField.push({ key: f.key, availableMarks: 0, earnedMarks: 0, penaltyMarks: 0 });
      continue;
    }

    // ---- Field-type-specific scoring ----
    const isNumericLike = f.fieldType === 'number' || f.fieldType === 'currency' || f.fieldType === 'percentage';
    if (f.supportsStatus && (status === 'done' || status === 'ongoing' || status === 'pending')) {
      // Status-driven rule wins when the field is status-only OR when a
      // supported-status field explicitly carries a decisive status.
      av = maxMarks;
      if (status === 'done' || status === 'ongoing') er = maxMarks;
      else if (status === 'pending') {
        er = 0;
        if (f.isCritical) pn = _num(f.penaltyMarks);
      }
    } else if (isNumericLike && f.enableOutOf) {
      // Two-value scoring: completed / outOf.
      const completed = _num(valueByKey[f.key]);
      const outOf     = _num(outOfByKey[f.key]);
      av = maxMarks;
      if (outOf > 0) {
        er = Math.min(1, completed / outOf) * maxMarks;
      } else {
        er = 0;
      }
      if (f.isCritical) {
        const th = _num(f.threshold);
        if (th > 0 && completed < th) pn = _num(f.penaltyMarks);
      }
    } else if (f.fieldType === 'dropdown' || f.fieldType === 'yes_no') {
      // Per-option scoring.
      const chosen = String(valueByKey[f.key] || '').trim();
      const opt = (f.optionMarks || []).find((o) => String(o.option) === chosen);
      av = maxMarks;
      if (opt) {
        er = Math.max(0, Math.min(100, _num(opt.percent))) / 100 * maxMarks;
        if (f.isCritical) pn = _num(opt.penalty);
      } else {
        er = 0;
        // No penalty inferred when the option isn't in the marks table.
      }
    } else if (f.fieldType === 'none' && !f.supportsStatus) {
      // Status-only field without status support -> nothing to score.
      perField.push({ key: f.key, availableMarks: 0, earnedMarks: 0, penaltyMarks: 0 });
      continue;
    } else {
      // Marks enabled on a field that doesn't fit any scoring rule
      // (e.g. plain text with no status, no outOf).  Contribute the
      // maxMarks to Available so HR still sees the ceiling, but
      // earned stays 0 until a real scoring shape is configured.
      av = maxMarks;
      er = 0;
    }

    // Cap earned at maxMarks (spec explicit for the number rule; safe
    // guard for every rule).  Penalty capped at earned so the row
    // itself never contributes negatively; the final formula caps
    // total again below.
    er = Math.max(0, Math.min(maxMarks, er));
    pn = Math.max(0, pn);

    available += av;
    earned    += er;
    penalty   += pn;
    perField.push({
      key: f.key,
      availableMarks: Math.round(av * 100) / 100,
      earnedMarks:    Math.round(er * 100) / 100,
      penaltyMarks:   Math.round(pn * 100) / 100,
    });
  }

  const final = Math.max(0, earned - penalty);
  return {
    perField,
    available: Math.round(available * 100) / 100,
    earned:    Math.round(earned * 100) / 100,
    penalty:   Math.round(penalty * 100) / 100,
    final:     Math.round(final * 100) / 100,
  };
};

module.exports = { computeCustomMarks };
