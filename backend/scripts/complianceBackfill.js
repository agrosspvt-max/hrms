#!/usr/bin/env node
/**
 * complianceBackfill.js -- CLI for the Phase 9 backfill job.
 *
 * Usage:
 *   node scripts/complianceBackfill.js                           # dry run
 *   node scripts/complianceBackfill.js --commit                  # write
 *   node scripts/complianceBackfill.js --commit --category=missed_submission
 *   node scripts/complianceBackfill.js --rollback                # dry rollback
 *   node scripts/complianceBackfill.js --rollback --commit       # rollback commit
 *   node scripts/complianceBackfill.js --help
 *
 * Requires backend/.env with MONGO_URI + `COMPLIANCE_LEGACY_BACKFILL=true`
 * for commit mode.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const backfill = require('../services/compliance/backfill/backfillJob');

const _flags = () => {
  const raw = process.argv.slice(2);
  const args = { commit: false, rollback: false, categories: null };
  for (const a of raw) {
    if (a === '--commit')    args.commit = true;
    else if (a === '--rollback') args.rollback = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--category=')) {
      const v = a.slice('--category='.length).trim();
      if (v) args.categories = (args.categories || []).concat(v);
    }
    else if (a.startsWith('--batch=')) {
      args.batchSize = Number(a.slice('--batch='.length));
    }
  }
  return args;
};

(async () => {
  const args = _flags();
  if (args.help) {
    console.log(`Compliance backfill

  --commit                write synthetic incidents / effects (default: dry-run)
  --rollback              remove synthetic incidents / effects (default: dry-run)
  --category=<name>       restrict to one Penalty.category (repeatable)
  --batch=<n>             batch size (default 500)
  --help                  show this text
`);
    process.exit(0);
  }
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI not set in backend/.env');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  try {
    if (args.rollback) {
      const r = await backfill.deleteSynthetic({ commit: !!args.commit });
      console.log(JSON.stringify(r, null, 2));
    } else {
      const r = await backfill.run({
        commit: !!args.commit,
        categories: args.categories,
        batchSize: args.batchSize,
      });
      console.log(JSON.stringify(r, null, 2));
    }
  } catch (e) {
    console.error('backfill failed:', e.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
