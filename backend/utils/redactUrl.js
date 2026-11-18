/**
 * redactUrl.js -- strip credential values from a request URL before it is
 * written to any log.
 *
 * EventSource (GET /api/realtime/stream?token=...) and the file-download
 * anchors (authUrl) must carry the JWT in the query string, so a plain
 * request logger would print live session tokens.  Every log line that
 * includes a URL goes through redactUrl() instead.
 *
 *   /api/salary/1/pdf?token=eyJ...&x=1  ->  /api/salary/1/pdf?token=[REDACTED]&x=1
 *
 * - Parameter names are matched case-insensitively, after URL-decoding,
 *   so `TOKEN=` and `%74oken=` are caught too.
 * - Every occurrence is redacted (repeated parameters included).
 * - Other parameters, their order and the path are left untouched.
 * - Never throws: on anything unexpected it hides the whole query string.
 */

const SENSITIVE_PARAMS = new Set(['token', 'access_token', 'refresh_token']);
const REDACTED = '[REDACTED]';

const decodeName = (raw) => {
  try { return decodeURIComponent(raw.replace(/\+/g, ' ')).trim().toLowerCase(); }
  catch (_) { return raw.trim().toLowerCase(); }
};

const redactUrl = (url) => {
  if (typeof url !== 'string' || url === '') return url;
  try {
    const q = url.indexOf('?');
    if (q === -1) return url;
    const hashAt = url.indexOf('#', q);
    const path = url.slice(0, q);
    const query = hashAt === -1 ? url.slice(q + 1) : url.slice(q + 1, hashAt);
    const hash = hashAt === -1 ? '' : url.slice(hashAt);
    const parts = query.split(/([&;])/);   // keep the separators as-is
    const out = parts.map((part) => {
      if (part === '&' || part === ';' || part === '') return part;
      const eq = part.indexOf('=');
      const name = eq === -1 ? part : part.slice(0, eq);
      if (!SENSITIVE_PARAMS.has(decodeName(name))) return part;
      return `${name}=${REDACTED}`;
    });
    return `${path}?${out.join('')}${hash}`;
  } catch (_) {
    const q = url.indexOf('?');
    return q === -1 ? url : `${url.slice(0, q)}?${REDACTED}`;
  }
};

module.exports = { redactUrl, SENSITIVE_PARAMS, REDACTED };
