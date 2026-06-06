/**
 * customTemplate.js
 *
 * Helpers for the Custom Assignment framework:
 *   - evalFormula(expr, values)
 *       Safe arithmetic evaluator over a { key: number } context.  Only
 *       digits, + - * / ( ) and field keys are allowed.  No function
 *       calls, no member access, no shell-escape -- the input is
 *       whitelisted via a strict regex before any evaluation.
 *
 *   - computeAutoFields(template, responses)
 *       Walks `template.customFields` in declaration order, evaluating
 *       any formula fields against responses already computed.  Returns
 *       a brand-new responses map with every auto field filled in.
 *
 *   - seedDefaultCallingTemplate()
 *       Idempotent seeder.  Adds the "Daily Calling Report" custom
 *       template on first boot if no template with kind='calling'
 *       exists.  All formulas and field metadata match the spec.
 */

const Template = require('../models/Template');

const SAFE_NUM_RE = /^[\s\d+\-*/().a-zA-Z_]+$/;

/**
 * Evaluate a formula like "yesterdayCallsCompleted + todayCallsCompleted"
 * against `values` (a plain map of key -> number).  Returns a Number.
 * Unknown keys are treated as 0 so partial submissions don't crash.
 *
 * Implementation detail: we substitute keys with their numeric values
 * THEN run `new Function('"use strict"; return (' + safeExpr + ')')`
 * -- which is fine because we've already restricted the alphabet via
 * SAFE_NUM_RE.  No JS identifiers survive substitution.
 */
const evalFormula = (expr, values = {}) => {
  if (!expr || typeof expr !== 'string') return 0;
  if (!SAFE_NUM_RE.test(expr)) return 0;
  let substituted = expr;
  // Replace each known key with its numeric value (longest first so
  // 'todayCallsCompleted' substitutes before 'today').
  const keys = Object.keys(values).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const num = Number(values[k]) || 0;
    substituted = substituted.replace(new RegExp(`\\b${k}\\b`, 'g'), `(${num})`);
  }
  // Any leftover identifier -> 0 (treat missing fields as zero).
  substituted = substituted.replace(/[a-zA-Z_][a-zA-Z0-9_]*/g, '0');
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('"use strict"; return (' + substituted + ');');
    const out = Number(fn());
    return Number.isFinite(out) ? out : 0;
  } catch (_) {
    return 0;
  }
};

/**
 * Given a template and the (employee-provided) raw responses, return
 * the full ordered responses array with auto fields evaluated.
 *
 * `responses` may arrive as either an array [{ key, value }] or a plain
 * { key: value } map; both are normalised.
 */
const computeAutoFields = (template, responses) => {
  const out = {};
  // Normalise incoming responses to a flat map.
  if (Array.isArray(responses)) {
    responses.forEach((r) => { if (r && r.key) out[r.key] = r.value; });
  } else if (responses && typeof responses === 'object') {
    Object.assign(out, responses);
  }
  // Walk fields in declared order so a formula can reference earlier
  // auto-computed fields (e.g. totalPending uses oldPendingRemaining +
  // todaysPending, both of which are also auto fields declared above it).
  const fields = (template.customFields || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  for (const f of fields) {
    if (f.fieldType === 'auto' && f.formula) {
      out[f.key] = evalFormula(f.formula, out);
    } else if (f.fieldType === 'number') {
      // Coerce number-typed fields to actual numbers so downstream
      // analytics / aggregations don't choke on string values.
      const raw = out[f.key];
      out[f.key] = raw === undefined || raw === null || raw === '' ? 0 : Number(raw) || 0;
    } else if (out[f.key] === undefined) {
      out[f.key] = '';
    }
  }
  // Re-emit as array in field-declaration order for the submission doc.
  return fields.map((f) => ({ key: f.key, value: out[f.key] }));
};

/**
 * Default Daily Calling Report custom template.  Encodes the entire
 * spec from PHASE 2 -- field types, groups, formulas, system-managed
 * yesterdayPending carry-forward, and role visibility.
 *
 * Fields are declared in dependency order: every formula only refers
 * to fields that come earlier in the array so the single-pass
 * evaluator in computeAutoFields() resolves them correctly.
 */
const CALLING_TEMPLATE_TITLE = 'Daily Calling Report';
const CALLING_TEMPLATE_KIND  = 'calling';

const buildCallingFields = () => [
  // Carried forward by the daily engine; employee never edits.
  { key: 'yesterdayPending',          label: 'Yesterday Pending',           fieldType: 'readonly', systemGenerated: true, group: 'Carry-forward',  order: 10 },

  { key: 'assignedCalls',             label: 'Assigned Calls',              fieldType: 'number',   required: true,        group: 'Today',          order: 20 },

  { key: 'yesterdayCallsCompleted',   label: 'Yesterday Calls Completed',   fieldType: 'number',   required: true,        group: 'Calls Completed', order: 30 },
  { key: 'todayCallsCompleted',       label: "Today's Calls Completed",     fieldType: 'number',   required: true,        group: 'Calls Completed', order: 40 },
  { key: 'totalCallsCompleted',       label: 'Total Calls Completed',       fieldType: 'auto',     formula: 'yesterdayCallsCompleted + todayCallsCompleted', group: 'Calls Completed', order: 50 },
  // Dialed Calls = total dial attempts (incl. retries to same farmer).
  // Distinct from totalCallsCompleted (which is unique-farmer reach) so
  // management can see actual calling effort.
  { key: 'dialedCalls',               label: 'Dialed Calls',                fieldType: 'number',   required: true,        group: 'Calls Completed', order: 55 },

  { key: 'attendedCalls',             label: 'Attended Calls',              fieldType: 'number',   required: true,        group: 'Connection',     order: 60 },
  // Unattended = dialed - attended (was totalCallsCompleted - attended).
  { key: 'unattendedCalls',           label: 'Unattended Calls',            fieldType: 'auto',     formula: 'dialedCalls - attendedCalls', group: 'Connection', order: 70 },

  { key: 'oldCustomerConversions',    label: 'Old Customer Conversions',    fieldType: 'number',   required: true,        group: 'Conversions',    order: 80 },
  { key: 'newCustomerConversions',    label: 'New Customer Conversions',    fieldType: 'number',   required: true,        group: 'Conversions',    order: 90 },
  { key: 'totalConversions',          label: 'Total Conversions',           fieldType: 'auto',     formula: 'oldCustomerConversions + newCustomerConversions', group: 'Conversions', order: 100 },
  { key: 'conversionRate',            label: 'Conversion Rate (%)',         fieldType: 'auto',     formula: '(totalConversions / attendedCalls) * 100',         group: 'Conversions', order: 110 },

  { key: 'oldPendingRemaining',       label: 'Old Pending Remaining',       fieldType: 'auto',     formula: 'yesterdayPending - yesterdayCallsCompleted', group: 'Pending', order: 120 },
  { key: 'todaysPending',             label: "Today's Pending",             fieldType: 'auto',     formula: 'assignedCalls - todayCallsCompleted',        group: 'Pending', order: 130 },
  { key: 'totalPending',              label: 'Total Pending',               fieldType: 'auto',     formula: 'oldPendingRemaining + todaysPending',        group: 'Pending', order: 140 },

  // KPIs -- computed at submit, surfaced by analytics.
  // Connection Rate now uses Dialed Calls (was totalCallsCompleted).
  { key: 'connectionRate',            label: 'Connection Rate (%)',         fieldType: 'auto',     formula: '(attendedCalls / dialedCalls) * 100',         group: 'KPIs', order: 150 },
  { key: 'pendingRate',               label: 'Pending Rate (%)',            fieldType: 'auto',     formula: '(totalPending / assignedCalls) * 100',        group: 'KPIs', order: 160 },
  { key: 'callCompletionRate',        label: 'Call Completion Rate (%)',    fieldType: 'auto',     formula: '(totalCallsCompleted / assignedCalls) * 100', group: 'KPIs', order: 170 },
];

const seedDefaultCallingTemplate = async () => {
  const existing = await Template.findOne({ customKind: CALLING_TEMPLATE_KIND });
  if (existing) {
    // SELF-HEAL: keep deployed tenants in lockstep with the latest
    // schema.  Walk every field declared by buildCallingFields() and
    // (a) insert it if missing, (b) overwrite its formula / metadata
    // if the canonical version drifted.  Idempotent: a fully-current
    // template logs "OK" with no writes.
    const want = buildCallingFields();
    const have = Array.isArray(existing.customFields) ? existing.customFields : [];
    let touched = false;
    const added = [];
    const changed = [];
    const next = want.map((w) => {
      const cur = have.find((f) => f.key === w.key);
      if (!cur) { added.push(w.key); touched = true; return w; }
      // Only treat a difference in formula / fieldType / required as
      // worth a rewrite -- preserve any custom HR edits to label/group.
      const out = { ...cur };
      if (w.formula   && out.formula !== w.formula)   { out.formula   = w.formula;   changed.push(w.key + ':formula'); touched = true; }
      if (w.fieldType && out.fieldType !== w.fieldType) { out.fieldType = w.fieldType; changed.push(w.key + ':type');    touched = true; }
      if (!!out.required !== !!w.required)            { out.required  = w.required;  changed.push(w.key + ':required'); touched = true; }
      // Re-stamp visibleTo to the canonical set if the original lost it.
      if (!Array.isArray(out.visibleTo) || out.visibleTo.length === 0) { out.visibleTo = ['employee', 'hod', 'hr', 'super_admin']; touched = true; }
      if (!out.label) { out.label = w.label; touched = true; }
      if (out.order === undefined || out.order === null) { out.order = w.order; touched = true; }
      if (!out.group) { out.group = w.group; touched = true; }
      if (w.systemGenerated !== undefined && !!out.systemGenerated !== !!w.systemGenerated) { out.systemGenerated = !!w.systemGenerated; touched = true; }
      return out;
    });
    // Preserve any HR-authored extra fields (key not in `want`).
    const extras = have.filter((f) => !want.find((w) => w.key === f.key));
    if (touched || extras.length === 0) existing.customFields = [...next, ...extras];
    if (touched) {
      await existing.save();
      console.log(`[seed] Daily Calling Report template found (id=${existing._id}) — self-healed: added [${added.join(', ') || '-'}], updated [${changed.join(', ') || '-'}]`);
    } else {
      console.log(`[seed] Daily Calling Report template found (id=${existing._id}) — OK, ${have.length} field(s)`);
    }
    return;
  }
  const created = await Template.create({
    title: CALLING_TEMPLATE_TITLE,
    description: 'Default calling activity report. Auto-calculated KPIs included.',
    templateType: 'custom',
    customKind: CALLING_TEMPLATE_KIND,
    customFields: buildCallingFields(),
    isActive: true,
  });
  console.log(`[seed] Daily Calling Report template created (id=${created._id})`);
};

/**
 * Default Product & Farmer Report template.  Uses the customSections
 * opt-in mechanism to surface the repeating Product Sales + Farmer
 * Records sub-tables -- no scalar customFields needed because all the
 * numbers (sales / NBV) are computed per-row.
 *
 * Future templates (Dealer Visit, Site Visit, Collection Report) can
 * subscribe to the same sections by listing them in customSections.
 */
const PRODUCT_FARMER_TEMPLATE_KIND = 'product_farmer';

const seedDefaultProductFarmerTemplate = async () => {
  const existing = await Template.findOne({ customKind: PRODUCT_FARMER_TEMPLATE_KIND });
  if (existing) {
    // SELF-HEAL: if a prior deploy / save corrupted the template (e.g.
    // an older normaliser stripped customSections), restore the
    // canonical opt-ins so the report stays functional.  Idempotent.
    const wanted = ['productSales', 'farmerRecords'];
    const have = Array.isArray(existing.customSections) ? existing.customSections : [];
    const missing = wanted.filter((s) => !have.includes(s));
    if (missing.length > 0) {
      existing.customSections = Array.from(new Set([...have, ...wanted]));
      existing.templateType = 'custom';
      existing.customKind = PRODUCT_FARMER_TEMPLATE_KIND;
      if (existing.isActive === undefined) existing.isActive = true;
      await existing.save();
      console.log(`[seed] Product & Farmer Report template found (id=${existing._id}) — restored missing sections: ${missing.join(', ')}`);
    } else {
      console.log(`[seed] Product & Farmer Report template found (id=${existing._id}) — sections OK: ${have.join(', ')}`);
    }
    return;
  }
  const created = await Template.create({
    title: 'Product & Farmer Report',
    description: 'Daily field report: record product sales (auto Sales Value + NBV) and farmer interactions.',
    templateType: 'custom',
    customKind: PRODUCT_FARMER_TEMPLATE_KIND,
    customSections: ['productSales', 'farmerRecords'],
    customFields: [],
    isActive: true,
  });
  console.log(`[seed] Product & Farmer Report template created (id=${created._id})`);
};

/**
 * One-time + boot-time migration for the Calling Report.  Earlier
 * deployments stored `customResponses` without `dialedCalls` because
 * the field didn't exist yet.  After this turn's spec change, the new
 * Connection Rate + Unattended Calls formulas reference dialedCalls,
 * so a missing field would produce negative unattended values and
 * zero connection rates on historic data.
 *
 * Backfill rule:
 *     dialedCalls = totalCallsCompleted     (closest pre-update equivalent)
 *
 * Math invariant:
 *   Old unattendedCalls = totalCallsCompleted - attendedCalls
 *   New unattendedCalls = dialedCalls        - attendedCalls
 *   With dialedCalls := totalCallsCompleted, the two are identical, so
 *   we don't need to rewrite unattendedCalls / connectionRate on
 *   historic rows -- their stored values stay consistent.
 *
 * Filter:
 *   templateType = 'custom'
 *   customKind   = 'calling'
 *   customResponses[].key never contains 'dialedCalls'
 *
 * Idempotent: re-runs match no rows after the first successful pass
 * (the $ne 'dialedCalls' filter is satisfied only by un-backfilled
 * documents).  Uses Mongo bulkWrite so a tenant with thousands of
 * historic submissions doesn't take minutes to migrate.
 */
const migrateCallingDialedCalls = async () => {
  const Submission = require('../models/Submission');
  const candidates = await Submission.find({
    templateType: 'custom',
    customKind: CALLING_TEMPLATE_KIND,
    'customResponses.key': { $ne: 'dialedCalls' },
  }).select('_id customResponses');

  if (candidates.length === 0) {
    console.log('[migrate] Backfilled dialedCalls on 0 historical calling submissions');
    return { backfilled: 0 };
  }

  const ops = candidates.map((sub) => {
    const totalRow = (sub.customResponses || []).find((r) => r.key === 'totalCallsCompleted');
    const value = Number(totalRow?.value) || 0;
    return {
      updateOne: {
        // Re-assert the $ne guard on the filter so a concurrent write
        // (HR editing the same submission) can't double-push.
        filter: { _id: sub._id, 'customResponses.key': { $ne: 'dialedCalls' } },
        update: { $push: { customResponses: { key: 'dialedCalls', value } } },
      },
    };
  });

  const result = await Submission.bulkWrite(ops, { ordered: false });
  const backfilled = (result?.modifiedCount != null ? result.modifiedCount : ops.length);
  console.log(`[migrate] Backfilled dialedCalls on ${backfilled} historical calling submissions`);
  return { backfilled };
};

module.exports = {
  evalFormula,
  computeAutoFields,
  seedDefaultCallingTemplate,
  seedDefaultProductFarmerTemplate,
  migrateCallingDialedCalls,
  CALLING_TEMPLATE_KIND,
  PRODUCT_FARMER_TEMPLATE_KIND,
};
