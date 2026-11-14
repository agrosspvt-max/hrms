/**
 * dealerProductSummary.js -- per-dealer "Product" column for Calling
 * Analytics (Per-Dealer Breakdown on screen + the Excel export).
 *
 * Built from the SAME dealer-linked farmerRecords[].products[] rows the
 * dealer breakdown already counts, so it never widens the dataset:
 *
 *   - grouped by saved productId + unit; rows without an id fall back to
 *     the saved product name (folded into an id group of the same name
 *     and unit when one exists, so a legacy row does not show twice)
 *   - display name = the saved (snapshot) name, never the live catalogue
 *   - quantities are summed, then rounded once to strip float artifacts
 *   - different units of the same product stay separate and are labelled
 *   - order: quantity desc, then name, then unit (deterministic)
 *
 * Output text: "VIPER(1), MAXX TRICHO(0.8)"; "—" when there is nothing.
 */

const EMPTY = '—';

/** Normally show up to four decimals, but keep a nonzero quantity visible. */
const roundQty = (n) => {
  const quantity = Number(n) || 0;
  const rounded = Math.round(quantity * 10000) / 10000;
  if (rounded !== 0) return rounded;
  // Strip floating-point noise from tiny sums without rounding them to zero.
  return Number(quantity.toPrecision(15));
};
const formatQty = (n) => String(roundQty(n));

const normName = (s) => String(s || '').trim().replace(/\s+/g, ' ').toUpperCase();
const normUnit = (u) => String(u || '').trim().toUpperCase();

/** Fresh accumulator for one dealer. */
const createAccumulator = () => new Map();

/** Add one farmerRecords[].products[] row to a dealer's accumulator. */
const addProduct = (acc, fp) => {
  if (!fp) return;
  const name = String(fp.productName || '').trim();
  const unit = normUnit(fp.productUnit);
  const id = fp.productId ? String(fp.productId) : '';
  if (!id && !name) return;                          // nothing to label
  const key = id ? `id:${id}|${unit}` : `name:${normName(name)}|${unit}`;
  if (!acc.has(key)) acc.set(key, { id, name, unit, qty: 0 });
  const g = acc.get(key);
  if (!g.name && name) g.name = name;                // first saved name wins
  g.qty += Number(fp.quantity) || 0;
};

/** Collapse an accumulator into ordered items + the display string. */
const summarize = (acc) => {
  const groups = [...(acc ? acc.values() : [])].map((g) => ({ ...g }));
  // Fold name-only groups into a single id group with the same name + unit.
  const byId = groups.filter((g) => g.id);
  const merged = [];
  for (const g of groups) {
    if (g.id) { merged.push(g); continue; }
    const twins = byId.filter((x) => x.unit === g.unit && normName(x.name) === normName(g.name));
    if (twins.length === 1) twins[0].qty += g.qty;
    else merged.push(g);
  }
  // Same display name recorded in more than one unit -> label the units.
  const unitsByName = new Map();
  for (const g of merged) {
    const n = normName(g.name);
    if (!unitsByName.has(n)) unitsByName.set(n, new Set());
    unitsByName.get(n).add(g.unit);
  }
  const items = merged.map((g) => {
    const name = g.name || EMPTY;
    const showUnit = unitsByName.get(normName(g.name)).size > 1;
    const qty = roundQty(g.qty);
    const unitLabel = showUnit ? (g.unit || 'unit n/a') : '';
    return {
      productId: g.id || null,
      name,
      unit: g.unit || '',
      qty,
      label: `${name}(${formatQty(qty)}${unitLabel ? ` ${unitLabel}` : ''})`,
    };
  }).sort((a, b) => (b.qty - a.qty)
    || a.name.localeCompare(b.name)
    || a.unit.localeCompare(b.unit)
    || String(a.productId || '').localeCompare(String(b.productId || '')));
  return { items, text: items.length ? items.map((i) => i.label).join(', ') : EMPTY };
};

module.exports = { EMPTY, roundQty, formatQty, createAccumulator, addProduct, summarize };
