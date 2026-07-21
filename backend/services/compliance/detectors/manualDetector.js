/**
 * manualDetector.js -- placeholder for detector:'manual' rules.
 *
 * Manual rules never produce candidates from the scheduler; HR
 * creates incidents directly via the API.  The registry needs an
 * entry so the scheduler can safely iterate every enabled rule
 * without a special case; this detector is the "safe zero" for that.
 */
const detect = async () => [];
module.exports = { detect, code: 'manual' };
