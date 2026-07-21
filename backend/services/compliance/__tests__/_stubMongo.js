/**
 * _stubMongo.js -- lightweight in-memory replacement for the Mongoose
 * model methods the Phase 4 code uses.
 *
 * Not a full mongodb-memory-server substitute -- we only implement
 * the chain calls actually used by the detectors, IncidentService and
 * ruleEvaluationScheduler.  Anything unimplemented throws loudly so
 * a code change that starts using a new method surfaces immediately.
 *
 * Data model: each model gets a `store` (Array of plain objects).
 * `find(query)` scans the array with a tiny predicate matcher; a
 * `MongoDuplicateKeyError` (code 11000) is thrown when `create` would
 * violate the model's declared `uniqueBy` fields.
 */

const mongoose = require('mongoose');

const _stores = new Map();      // modelName -> { rows: [], uniqueBy: [] }
const _savedOriginals = new Map();  // Model -> { method: fn }
let _tickCounter = 0;               // monotonic timestamp tie-break

// Resolve a dotted path against a row.  Mirrors Mongo's implicit
// "any element" semantics: when a segment resolves to an array, the
// remaining path is evaluated against each element and the first
// non-undefined match wins.  Distinguishes "value is null" (returns
// null so `find({field:null})` matches) from "path missing" (returns
// undefined).
const _resolvePath = (row, path) => {
  const parts = path.split('.');
  const walk = (cur, i) => {
    if (i === parts.length) return cur;
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      for (const el of cur) {
        const r = walk(el, i);
        if (r !== undefined) return r;
      }
      return undefined;
    }
    return walk(cur[parts[i]], i + 1);
  };
  return walk(row, 0);
};

const _matches = (row, query) => {
  if (!query || typeof query !== 'object') return true;
  for (const [k, v] of Object.entries(query)) {
    if (k === '$or' && Array.isArray(v)) {
      if (!v.some((sub) => _matches(row, sub))) return false;
      continue;
    }
    const rowVal = _resolvePath(row, k);
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)
        && !(v instanceof mongoose.Types.ObjectId)) {
      for (const [op, opV] of Object.entries(v)) {
        if (op === '$in')  { if (!opV.some((x) => String(x) === String(rowVal))) return false; }
        else if (op === '$nin') { if (opV.some((x) => String(x) === String(rowVal))) return false; }
        else if (op === '$ne')  { if (String(rowVal) === String(opV)) return false; }
        else if (op === '$gt')  { if (!(new Date(rowVal) >  new Date(opV))) return false; }
        else if (op === '$gte') { if (!(new Date(rowVal) >= new Date(opV))) return false; }
        else if (op === '$lt')  { if (!(new Date(rowVal) <  new Date(opV))) return false; }
        else if (op === '$lte') { if (!(new Date(rowVal) <= new Date(opV))) return false; }
        else if (op === '$regex') {
          const re = opV instanceof RegExp ? opV : new RegExp(String(opV));
          if (rowVal == null || !re.test(String(rowVal))) return false;
        }
        else if (op === '$exists') {
          const has = rowVal !== undefined;
          if (!!opV !== has) return false;
        }
        else throw new Error('stubMongo: unsupported query op ' + op);
      }
    } else {
      if (String(rowVal) !== String(v)) return false;
    }
  }
  return true;
};

// Numeric comparator that treats Dates and ISO-strings consistently.
const _cmp = (a, b) => {
  if (a instanceof Date || b instanceof Date) return new Date(a) - new Date(b);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
};

const _chain = (rows) => {
  const self = {
    _rows: rows.slice(),
    select() { return self; },
    sort(spec) {
      const keys = Object.keys(spec || {});
      self._rows.sort((a, b) => {
        for (const k of keys) {
          const dir = spec[k] < 0 ? -1 : 1;
          const av = _resolvePath(a, k);
          const bv = _resolvePath(b, k);
          const c = _cmp(av, bv);
          if (c !== 0) return dir * c;
        }
        return 0;
      });
      return self;
    },
    limit(n) {
      const cap = Math.max(0, Number(n) || 0);
      self._rows = self._rows.slice(0, cap);
      return self;
    },
    skip(n) {
      const off = Math.max(0, Number(n) || 0);
      self._rows = self._rows.slice(off);
      return self;
    },
    populate() { return self; },
    session() { return self; },
    // lean() returns self (chainable) -- matches Mongoose behaviour
    // where .lean() is a chainable Query modifier.  Awaiting it still
    // yields the row array via the thenable below, and .cursor() /
    // .sort() remain callable after .lean().
    lean() { return self; },
    async exec()  { return self._rows.slice(); },
    then(resolve, reject) { return Promise.resolve(self._rows.slice()).then(resolve, reject); },
    // Cursor stub -- Mongoose returns an EventEmitter with an
    // async iterator.  We only need the async-iterable surface plus
    // an optional close() no-op.  Snapshot `_rows` at cursor time so
    // later `.sort()` on the chain doesn't perturb iteration.
    cursor() {
      const snapshot = self._rows.slice();
      return {
        async close() {},
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            async next() {
              return i < snapshot.length
                ? { value: snapshot[i++], done: false }
                : { value: undefined, done: true };
            },
          };
        },
      };
    },
  };
  return self;
};

const _cloneWithId = (doc) => ({
  _id: doc._id || new mongoose.Types.ObjectId(),
  ...doc,
});

const install = (Model, { name, uniqueBy = [] } = {}) => {
  const modelName = name || Model.modelName;
  const store = { rows: [], uniqueBy };
  _stores.set(modelName, store);
  // Marker so production code paths (e.g. workingDayContext) can
  // distinguish "test stub installed" from "Mongo is offline" --
  // both would otherwise show mongoose.connection.readyState !== 1.
  Model._stubbedByStubMongo = true;

  const saved = {};
  ['find', 'findOne', 'findById', 'findOneAndUpdate', 'create', 'updateMany',
   'countDocuments', 'deleteMany', 'syncIndexes'].forEach((m) => {
    if (Model[m]) saved[m] = Model[m];
  });
  _savedOriginals.set(Model, saved);

  Model.find = (query = {}) => _chain(store.rows.filter((r) => _matches(r, query)));
  // findOne must support both chain-friendliness (.select().lean())
  // and direct await.  When awaited without .lean(), we return the
  // ORIGINAL store reference so mutations + .save() persist -- matches
  // Mongoose's document behaviour and is what IncidentService relies on.
  //
  // The chain's `.sort()` mutates `_rows`, so `_rows[0]` is only
  // reliable at the moment `.lean()` / `.then()` / `.exec()` fire.
  Model.findOne = (query = {}) => {
    const filtered = store.rows.filter((r) => _matches(r, query));
    const chain = _chain(filtered);
    chain.lean  = async () => (chain._rows[0] ? { ...chain._rows[0] } : null);
    chain.exec  = async () => (chain._rows[0] || null);
    chain.then  = (resolve, reject) =>
      Promise.resolve(chain._rows[0] || null).then(resolve, reject);
    return chain;
  };
  Model.findById = (id) => Model.findOne({ _id: id });
  Model.countDocuments = async (query = {}) =>
    store.rows.filter((r) => _matches(r, query)).length;
  Model.deleteMany = async (query = {}) => {
    const before = store.rows.length;
    store.rows = store.rows.filter((r) => !_matches(r, query));
    return { deletedCount: before - store.rows.length };
  };
  Model.updateMany = async (query, patch) => {
    let n = 0;
    for (const r of store.rows) {
      if (!_matches(r, query)) continue;
      Object.assign(r, patch.$set || {});
      n += 1;
    }
    return { modifiedCount: n };
  };
  Model.updateOne = async (query, patch) => {
    for (const r of store.rows) {
      if (!_matches(r, query)) continue;
      Object.assign(r, patch.$set || {});
      return { modifiedCount: 1, matchedCount: 1 };
    }
    return { modifiedCount: 0, matchedCount: 0 };
  };
  Model.syncIndexes = async () => {};
  Model.findOneAndUpdate = async (query, patch, opts = {}) => {
    const idx = store.rows.findIndex((r) => _matches(r, query));
    if (idx >= 0) {
      Object.assign(store.rows[idx], patch.$set || {});
      return opts.new ? { ...store.rows[idx] } : store.rows[idx];
    }
    if (opts.upsert) {
      const created = _cloneWithId({
        ...(patch.$setOnInsert || {}),
        ...(patch.$set || {}),
      });
      store.rows.push(created);
      return created;
    }
    return null;
  };
  Model.create = async (docs) => {
    const list = Array.isArray(docs) ? docs : [docs];
    const created = [];
    for (const d of list) {
      // Uniqueness check across `uniqueBy` combinations.
      for (const combo of uniqueBy) {
        const dupe = store.rows.find((r) =>
          combo.every((k) => String(r[k]) === String(d[k]))
          && (!combo.filter || Object.entries(combo.filter).every(([kk, vv]) => r[kk] === vv))
        );
        if (dupe) {
          const err = new Error('E11000 duplicate key error (stub)');
          err.code = 11000;
          throw err;
        }
      }
      const row = _cloneWithId(d);
      // Reflect Mongoose default timestamps.  In production, Mongo's
      // ObjectId embeds a timestamp that tie-breaks same-millisecond
      // sorts; here we bump by a synthetic millisecond so
      // `.sort({createdAt:-1})` is stable.
      _tickCounter += 1;
      row.createdAt = row.createdAt || new Date(Date.now() + _tickCounter);
      row.updatedAt = row.updatedAt || row.createdAt;
      // Provide `toObject`, `save`, `save` mutator so IncidentService can call them.
      row.toObject = function () { const clone = { ...this }; delete clone.toObject; delete clone.save; return clone; };
      row.save = async function () {
        this.updatedAt = new Date();
        // In-store row is the same reference; nothing else needed.
        return this;
      };
      store.rows.push(row);
      created.push(row);
    }
    return Array.isArray(docs) ? created : created[0];
  };
};

const store = (Model) => _stores.get(Model.modelName || Model);

const rows = (Model) => (store(Model) || { rows: [] }).rows;

const reset = () => {
  for (const s of _stores.values()) s.rows = [];
};

const restore = () => {
  for (const [Model, saved] of _savedOriginals.entries()) {
    for (const [m, fn] of Object.entries(saved)) Model[m] = fn;
    delete Model._stubbedByStubMongo;
  }
  _stores.clear();
  _savedOriginals.clear();
};

// Public signal for non-model services (e.g., workingDayContext)
// that want to know "test stubs are installed, treat as connected".
const isTestMode = () => _stores.size > 0;

module.exports = { install, store, rows, reset, restore, isTestMode };
