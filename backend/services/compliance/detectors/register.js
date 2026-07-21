/**
 * detectors/register.js -- one-shot registration of every built-in
 * detector against the detectorRegistry.
 *
 * Called once from the compliance barrel at import time.  Re-imports
 * are safe -- the registry throws on duplicate register(), so we
 * guard with a boolean latch.
 */

const detectorRegistry = require('../registry/detectorRegistry');

const _built_ins = [
  require('./missedSubmissionDetector'),
  require('./dependencyDetector'),
  require('./performanceLockDetector'),
  require('./manualDetector'),
];

let _done = false;

const registerAll = () => {
  if (_done) return;
  for (const d of _built_ins) {
    if (!detectorRegistry.get(d.code)) {
      detectorRegistry.register(d.code, d.detect);
    }
  }
  _done = true;
};

module.exports = { registerAll, _built_ins };
