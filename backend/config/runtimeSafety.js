/**
 * runtimeSafety.js -- stops a non-production process from silently pointing
 * at a shared (remote) MongoDB and running boot-time writers against it.
 *
 * Why: `backend/.env` can carry NODE_ENV=development together with a remote
 * Atlas MONGO_URI.  `npm run dev` would then run every boot migration, seed
 * and scheduler against live company data, and `node seed.js` would run
 * `deleteMany({})` on it.
 *
 * Policy (the URI is never logged or put in an error message; only the
 * classification is):
 *
 *   local host (localhost / 127.0.0.1 / ::1)      -> always allowed
 *   NODE_ENV=production                           -> allowed, unchanged
 *   NODE_ENV=test      + remote host              -> REFUSED, no override
 *   NODE_ENV=development + remote host            -> REFUSED unless
 *        ALLOW_SHARED_DB_DEV=true  (loud warning).  Even then boot-time
 *        migrations/seeds/schedulers stay OFF unless
 *        ALLOW_SHARED_DB_DEV_JOBS=true as well.
 *   hosting-platform marker (RENDER, DYNO, ...) + any NODE_ENV but test
 *                                                 -> allowed with a warning, so a
 *        deployed server with a wrong NODE_ENV is never locked out
 *   NODE_ENV unset/other (e.g. staging) + remote  -> allowed with a warning
 *        (unchanged behaviour: an unknown host that does not set
 *        NODE_ENV=production keeps starting; set it to silence the warning)
 *
 * Production must therefore keep working with NODE_ENV=production OR with
 * NODE_ENV unset; only an explicit development/test marker triggers a refusal.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

// Variables PaaS hosts set on every deployed process (never on a laptop).  A
// deployed server that was misconfigured with NODE_ENV=development must keep
// starting (with a warning) rather than be locked out by the guard.
const HOSTED_MARKERS = ['RENDER', 'RAILWAY_ENVIRONMENT', 'RAILWAY_PROJECT_ID', 'FLY_APP_NAME', 'DYNO',
  'K_SERVICE', 'WEBSITE_SITE_NAME', 'VERCEL', 'AWS_EXECUTION_ENV', 'KUBERNETES_SERVICE_HOST'];
const isHosted = (env) => HOSTED_MARKERS.some((k) => env[k]);

class UnsafeDatabaseTargetError extends Error {
  constructor(message) { super(message); this.name = 'UnsafeDatabaseTargetError'; }
}

/** Hosts named in a mongodb:// or mongodb+srv:// URI, without credentials. */
const hostsOf = (uri) => {
  const s = String(uri || '');
  const m = s.match(/^mongodb(\+srv)?:\/\/(.*)$/i);
  if (!m) return { srv: false, hosts: [] };
  let rest = m[2];
  const slash = rest.indexOf('/');
  const authority = slash >= 0 ? rest.slice(0, slash) : rest.split('?')[0];
  const at = authority.lastIndexOf('@');
  const hostPart = at >= 0 ? authority.slice(at + 1) : authority;
  const hosts = hostPart.split(',').map((h) => {
    const t = h.trim().toLowerCase();
    if (t.startsWith('[')) return t.slice(0, t.indexOf(']') + 1);        // [::1]:27017
    return t.replace(/:\d+$/, '');
  }).filter(Boolean);
  return { srv: !!m[1], hosts };
};

const isLocalUri = (uri) => {
  const { srv, hosts } = hostsOf(uri);
  if (srv || !hosts.length) return false;                                // +srv is never local
  return hosts.every((h) => LOCAL_HOSTS.has(h) || h.endsWith('.localhost'));
};

/**
 * Classify the target.  Pure: no I/O, no logging.
 * Returns { mode, allowed, jobs, reason } where mode is one of
 * 'local' | 'production' | 'hosted' | 'shared-dev' | 'unclassified' | 'refused'.
 */
const evaluate = (uri, env = process.env) => {
  const nodeEnv = String(env.NODE_ENV || '').trim().toLowerCase();
  if (!uri) return { mode: 'refused', allowed: false, jobs: false, reason: 'MONGO_URI is not set.' };
  if (isLocalUri(uri)) return { mode: 'local', allowed: true, jobs: true, reason: 'local database' };
  if (nodeEnv === 'production') return { mode: 'production', allowed: true, jobs: true, reason: 'NODE_ENV=production' };
  if (isHosted(env) && nodeEnv !== 'test') {
    return { mode: 'hosted', allowed: true, jobs: true,
      reason: `running on a hosting platform with NODE_ENV=${nodeEnv || 'unset'}; set NODE_ENV=production` };
  }
  if (nodeEnv === 'test') {
    return { mode: 'refused', allowed: false, jobs: false,
      reason: 'NODE_ENV=test must never connect to a remote database.' };
  }
  if (nodeEnv === 'development') {
    if (String(env.ALLOW_SHARED_DB_DEV || '') === 'true') {
      return { mode: 'shared-dev', allowed: true, jobs: String(env.ALLOW_SHARED_DB_DEV_JOBS || '') === 'true',
        reason: 'ALLOW_SHARED_DB_DEV=true' };
    }
    return { mode: 'refused', allowed: false, jobs: false,
      reason: 'NODE_ENV=development but MONGO_URI points to a remote (shared) database. '
        + 'Use a local MongoDB (e.g. mongodb://127.0.0.1:27017/hrms) for development, '
        + 'or set ALLOW_SHARED_DB_DEV=true to knowingly use the shared database.' };
  }
  return { mode: 'unclassified', allowed: true, jobs: true,
    reason: `NODE_ENV is ${nodeEnv || 'unset'} and the database is remote; set NODE_ENV=production on deployed servers` };
};

/** Throws UnsafeDatabaseTargetError when the target is refused; logs warnings otherwise. */
const assertDatabaseTarget = (uri, env = process.env, log = console) => {
  const r = evaluate(uri, env);
  if (!r.allowed) throw new UnsafeDatabaseTargetError(`Refusing to start: ${r.reason}`);
  if (r.mode === 'shared-dev') {
    log.warn('[safety] ⚠ SHARED DATABASE IN DEVELOPMENT (ALLOW_SHARED_DB_DEV=true). API requests can modify live data.'
      + (r.jobs ? ' Background jobs/migrations are ENABLED (ALLOW_SHARED_DB_DEV_JOBS=true).'
        : ' Boot migrations, seeds and schedulers are DISABLED.'));
  } else if (r.mode === 'unclassified' || r.mode === 'hosted') {
    log.warn(`[safety] ${r.reason}.`);
  }
  return r;
};

/** Boot-time writers (migrations, seeds, schedulers) may run for this target? */
const backgroundJobsAllowed = (uri = process.env.MONGO_URI, env = process.env) => {
  const r = evaluate(uri, env);
  return r.allowed && r.jobs;
};

/** For destructive tooling (e.g. seed.js): only ever a local database, no override. */
const assertLocalOnly = (uri, what, env = process.env) => {
  if (!isLocalUri(uri)) {
    throw new UnsafeDatabaseTargetError(`Refusing to run ${what}: it is destructive and only allowed against a local database.`);
  }
  return true;
};

module.exports = {
  evaluate, assertDatabaseTarget, isHosted, backgroundJobsAllowed, assertLocalOnly,
  isLocalUri, hostsOf, UnsafeDatabaseTargetError,
};
