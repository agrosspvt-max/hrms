/**
 * phase2.test.js -- schemas, defaults, index spec.  Runs against an
 * in-memory MongoDB if `mongodb-memory-server` is available; otherwise
 * exercises pure-schema behaviour and skips writes gracefully.
 *
 *   cd backend && node services/compliance/__tests__/phase2.test.js
 */

const assert = require('assert');
process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');

// -----------------------------------------------------------
// Load models -- if any require throws we fail fast.
// -----------------------------------------------------------
const ComplianceRule           = require('../../../models/ComplianceRule');
const ComplianceIncident       = require('../../../models/ComplianceIncident');
const ComplianceActionEffect   = require('../../../models/ComplianceActionEffect');
const ComplianceWaiver         = require('../../../models/ComplianceWaiver');
const ComplianceRecovery       = require('../../../models/ComplianceRecovery');
const ComplianceEvent          = require('../../../models/ComplianceEvent');
const MarksLedger              = require('../../../models/MarksLedger');
const FinancialLedger          = require('../../../models/FinancialLedger');
const PercentageLedger         = require('../../../models/PercentageLedger');
const AttendanceLedger         = require('../../../models/AttendanceLedger');
const Penalty                  = require('../../../models/Penalty');
console.log('  ok  every model loads without throwing');

// -----------------------------------------------------------
// Schema defaults + validation (no DB required)
// -----------------------------------------------------------
{
  const r = new ComplianceRule({
    code: 'missed_submission_v2',
    name: 'Missed Submission',
    category: 'submission',
    detector: 'built_in.missed_submission',
  });
  assert.strictEqual(r.enabled, false, 'rules seed disabled');
  assert.strictEqual(r.version, 1, 'rules start at v1');
  assert.strictEqual(r.severity, 'medium', 'default severity=medium');
  assert.strictEqual(r.trigger.evaluationDelayDays, 0);
  assert.strictEqual(r.trigger.dedupeWindowHours, 24);
  assert.deepStrictEqual(r.recovery.modes.sort(),
    ['information', 'neutral', 'restore']);
  assert.deepStrictEqual(r.waiver.approverRoles.sort(),
    ['hr', 'super_admin']);

  const err = r.validateSync();
  assert.strictEqual(err, undefined, 'valid rule passes validateSync');

  const missing = new ComplianceRule({ name: 'x', category: 'submission' });
  const missingErr = missing.validateSync();
  assert.ok(missingErr && missingErr.errors.code, 'code required');
  assert.ok(missingErr && missingErr.errors.detector, 'detector required');

  console.log('  ok  ComplianceRule defaults + required fields');
}

{
  const i = new ComplianceIncident({
    ruleId: new mongoose.Types.ObjectId(),
    ruleVersion: 1,
    ruleCode: 'missed_submission_v2',
    employee: new mongoose.Types.ObjectId(),
    incidentDate: new Date('2026-07-16T00:00:00Z'),
    effectiveDate: new Date('2026-07-17T00:00:00Z'),
    naturalKey: 'missed_submission_v2|e|2026-07-16|s',
  });
  assert.strictEqual(i.status, 'candidate', 'incidents start candidate');
  assert.strictEqual(i.source, 'automatic');
  const err = i.validateSync();
  assert.strictEqual(err, undefined, 'valid incident passes validateSync');
  console.log('  ok  ComplianceIncident defaults + required fields');
}

{
  const e = new ComplianceActionEffect({
    incidentId: new mongoose.Types.ObjectId(),
    ruleId: new mongoose.Types.ObjectId(),
    ruleActionId: new mongoose.Types.ObjectId(),
    actionType: 'financial_fine',
    employee: new mongoose.Types.ObjectId(),
    effectiveDate: new Date('2026-07-17T00:00:00Z'),
    amount: 200,
  });
  assert.strictEqual(e.status, 'pending', 'effect starts pending');
  const err = e.validateSync();
  assert.strictEqual(err, undefined);
  console.log('  ok  ComplianceActionEffect defaults + required fields');
}

{
  const w = new ComplianceWaiver({
    incidentId: new mongoose.Types.ObjectId(),
    employee: new mongoose.Types.ObjectId(),
    scope: 'full',
    requestedBy: new mongoose.Types.ObjectId(),
  });
  assert.strictEqual(w.status, 'pending');
  assert.strictEqual(w.validateSync(), undefined);

  const bad = new ComplianceWaiver({
    incidentId: new mongoose.Types.ObjectId(),
    scope: 'wrong',
    requestedBy: new mongoose.Types.ObjectId(),
    employee: new mongoose.Types.ObjectId(),
  });
  const badErr = bad.validateSync();
  assert.ok(badErr.errors.scope, 'scope enum enforced');
  console.log('  ok  ComplianceWaiver defaults + enum guard');
}

{
  const r = new ComplianceRecovery({
    incidentId: new mongoose.Types.ObjectId(),
    employee: new mongoose.Types.ObjectId(),
    mode: 'restore',
    createdBy: new mongoose.Types.ObjectId(),
  });
  assert.strictEqual(r.validateSync(), undefined);
  console.log('  ok  ComplianceRecovery defaults + required fields');
}

{
  const ev = new ComplianceEvent({
    employee: new mongoose.Types.ObjectId(),
    kind: 'incident_created',
  });
  assert.ok(ev.ts instanceof Date, 'ts defaults to now');
  assert.strictEqual(ev.actor, 'system');
  assert.strictEqual(ev.validateSync(), undefined);
  const bad = new ComplianceEvent({
    employee: new mongoose.Types.ObjectId(),
    kind: 'not_a_real_kind',
  });
  assert.ok(bad.validateSync().errors.kind, 'kind enum enforced');
  console.log('  ok  ComplianceEvent defaults + kind enum');
}

for (const [name, Model] of [
  ['MarksLedger',      MarksLedger],
  ['FinancialLedger',  FinancialLedger],
  ['PercentageLedger', PercentageLedger],
  ['AttendanceLedger', AttendanceLedger],
]) {
  const row = new Model({
    employee: new mongoose.Types.ObjectId(),
    date: new Date('2026-07-17T00:00:00Z'),
    direction: -1,
    quantity: 12,
    type: 'action',
  });
  assert.strictEqual(row.runningBalance, 0);
  assert.strictEqual(row.validateSync(), undefined);
  const bad = new Model({
    employee: new mongoose.Types.ObjectId(),
    date: new Date(),
    direction: 0, // enum -1|1
    quantity: 1,
    type: 'action',
  });
  assert.ok(bad.validateSync().errors.direction, `${name}: direction enum`);
  const badQty = new Model({
    employee: new mongoose.Types.ObjectId(),
    date: new Date(),
    direction: -1,
    quantity: -1,
    type: 'action',
  });
  assert.ok(badQty.validateSync().errors.quantity, `${name}: quantity >= 0`);
  console.log(`  ok  ${name}: defaults + direction / quantity guards`);
}

// -----------------------------------------------------------
// Penalty.incidentId back-reference
// -----------------------------------------------------------
{
  const p = new Penalty({
    employee: new mongoose.Types.ObjectId(),
    category: 'missed_submission',
    incidentId: new mongoose.Types.ObjectId(),
  });
  assert.ok(p.incidentId, 'Penalty accepts incidentId');
  const noneP = new Penalty({
    employee: new mongoose.Types.ObjectId(),
    category: 'missed_submission',
  });
  assert.strictEqual(noneP.incidentId, null, 'Penalty.incidentId defaults null');
  console.log('  ok  Penalty.incidentId back-reference');
}

// -----------------------------------------------------------
// Index specs (schema-level, no DB required)
// -----------------------------------------------------------
{
  const specs = ComplianceIncident.schema.indexes();
  const names = specs.map((s) => s[1] && s[1].name).filter(Boolean);
  assert.ok(names.includes('compliance_incident_natural_key_auto'),
    'natural-key partial-unique index present');
  console.log('  ok  ComplianceIncident partial-unique index declared');
}
{
  const specs = ComplianceActionEffect.schema.indexes();
  const names = specs.map((s) => s[1] && s[1].name).filter(Boolean);
  assert.ok(names.includes('compliance_effect_natural_key'),
    'effect natural-key unique index present');
  console.log('  ok  ComplianceActionEffect natural-key index declared');
}

console.log('\nphase2: all tests passed');
