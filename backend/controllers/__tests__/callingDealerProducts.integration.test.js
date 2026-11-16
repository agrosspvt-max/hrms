/**
 * callingDealerProducts.integration.test.js -- Calling Analytics
 * Per-Dealer "Product" column + the two breakdown worksheets in the
 * Calling Analytics Excel export.
 *
 * Runs the REAL callingAnalytics / exportCallingAnalytics handlers
 * against a disposable mongod (never a shared database), then parses the
 * downloaded workbook with ExcelJS.
 *
 *   cd backend && MONGOMS_SYSTEM_BINARY=$(which mongod) node controllers/__tests__/callingDealerProducts.integration.test.js
 *
 * Prints SKIPPED and exits 0 when no mongod can be started.
 */
process.env.NODE_ENV = 'test';

const assert = require('assert');
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const dps = require('../../utils/dealerProductSummary');
const { valueFarmerPurchases } = require('../../services/farmerPurchases');

let n = 0; const ok = (m) => { n += 1; console.log(`  ok  ${n}: ${m}`); };
const oid = () => new mongoose.Types.ObjectId();

/* ------------------------------------------------------------------ */
/* Pure helper checks (no DB)                                          */
/* ------------------------------------------------------------------ */
const pure = () => {
  assert.strictEqual(dps.formatQty(0.1 + 0.2), '0.3');
  assert.strictEqual(dps.formatQty(1.5), '1.5');
  assert.strictEqual(dps.formatQty(2), '2');
  assert.strictEqual(dps.formatQty(0.125), '0.125');
  assert.strictEqual(dps.formatQty(1 / 3), '0.3333');
  assert.strictEqual(dps.formatQty(-0), '0');
  ok('quantity formatting: float artifacts removed, trailing zeros dropped, decimals kept');

  assert.strictEqual(dps.formatQty(0.00004), '0.00004');
  assert.strictEqual(dps.formatQty(0.00001 + 0.00003), '0.00004');
  ok('small positive quantities and sums do not round to zero');

  const P1 = oid(), P2 = oid();
  const a = dps.createAccumulator();
  dps.addProduct(a, { productId: P1, productName: 'VIPER', productUnit: 'L', quantity: 0.4 });
  dps.addProduct(a, { productId: P2, productName: 'MAXX TRICHO', productUnit: 'L', quantity: 0.8 });
  dps.addProduct(a, { productId: P1, productName: 'VIPER', productUnit: 'L', quantity: 0.6 });
  assert.strictEqual(dps.summarize(a).text, 'VIPER(1), MAXX TRICHO(0.8)');
  ok('spec example: VIPER 0.4 + 0.6 and MAXX TRICHO 0.8 -> "VIPER(1), MAXX TRICHO(0.8)"');

  const b = dps.createAccumulator();
  dps.addProduct(b, { productId: P1, productName: 'VIPER', productUnit: 'L', quantity: 1 });
  dps.addProduct(b, { productId: P1, productName: 'VIPER', productUnit: 'KG', quantity: 2 });
  assert.strictEqual(dps.summarize(b).text, 'VIPER(2 KG), VIPER(1 L)');
  ok('same product in two units: kept separate and labelled ("VIPER(2 KG), VIPER(1 L)")');

  const c = dps.createAccumulator();
  dps.addProduct(c, { productId: P1, productName: 'VIPER', productUnit: 'L', quantity: 0.5 });
  dps.addProduct(c, { productName: ' viper ', productUnit: 'L', quantity: 0.25 });     // legacy, no id
  dps.addProduct(c, { productId: P1, productName: 'VIPER (renamed)', productUnit: 'L', quantity: 0.25 });
  assert.strictEqual(dps.summarize(c).text, 'VIPER(1)');
  ok('id-less row folds into the same-name id group; first saved name kept across a rename');

  assert.strictEqual(dps.summarize(dps.createAccumulator()).text, '—');
  assert.strictEqual(dps.summarize(undefined).text, '—');
  const d = dps.createAccumulator();
  dps.addProduct(d, { quantity: 3 });   // no id, no name -> nothing to label
  assert.strictEqual(dps.summarize(d).text, '—');
  ok('no product details -> em dash');

  const e1 = dps.createAccumulator(), e2 = dps.createAccumulator();
  const rows = [['B', 1], ['A', 1], ['C', 2]].map(([nm, q]) => ({ productId: oid(), productName: nm, productUnit: 'L', quantity: q }));
  rows.forEach((r) => dps.addProduct(e1, r));
  [...rows].reverse().forEach((r) => dps.addProduct(e2, r));
  assert.strictEqual(dps.summarize(e1).text, 'C(2), A(1), B(1)');
  assert.strictEqual(dps.summarize(e2).text, dps.summarize(e1).text);
  ok('stable order (quantity desc, then name) regardless of input order');


};

/* ------------------------------------------------------------------ */
/* Real MongoDB: handlers + workbook                                   */
/* ------------------------------------------------------------------ */
const mkRes = () => {
  const r = { statusCode: 200, headers: {} };
  r.status = (s) => { r.statusCode = s; return r; };
  r.json = (v) => { r.body = v; return r; };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.set = r.setHeader;
  r.send = (b) => { r.body = b; return r; };
  return r;
};
const run = async (handler, user, query, extras = {}) => {
  const res = mkRes(); let err = null;
  await handler({ user, query, params: {}, ...extras }, res, (e) => { err = e; });
  if (err) { err.statusCode = res.statusCode; throw err; }
  return res;
};

const suite = async (uri) => {
  require('../../config/runtimeSafety').assertLocalOnly(uri, 'integration test');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  const db = mongoose.connection.db;
  const analytics = require('../analyticsController');
  const dealers = require('../dealerController');

  const deptA = oid(), deptB = oid();
  await db.collection('departments').insertMany([{ _id: deptA, name: 'Sales A' }, { _id: deptB, name: 'Sales B' }]);
  const emp1 = oid(), emp2 = oid(), emp3 = oid();
  await db.collection('users').insertMany([
    { _id: emp1, name: 'Asha',  employeeId: 'T001', email: 't001@example.test', status: 'active', role: 'employee', department: deptA },
    { _id: emp2, name: 'Bharat', employeeId: 'T002', email: 't002@example.test', status: 'active', role: 'employee', department: deptA },
    { _id: emp3, name: 'Chitra', employeeId: 'T003', email: 't003@example.test', status: 'active', role: 'employee', department: deptB },
  ]);
  // D1 and D2 share a firm name (different places): must never merge.
  const D1 = oid(), D2 = oid(), D3 = oid(), D4 = oid();
  await db.collection('dealers').insertMany([
    { _id: D1, firmName: 'Krishna Agro', place: 'Nashik', dealerName: 'Ramesh', state: 'MP', active: true },
    { _id: D2, firmName: 'Krishna Agro', place: 'Pune',   dealerName: 'Suresh', state: 'CG', active: false },
    { _id: D3, firmName: 'Green Field',  place: 'Satara', dealerName: 'Mahesh', active: true },
    { _id: D4, firmName: 'Empty Farm Supply', place: 'Sangli', dealerName: 'Ganesh', active: true },
  ]);
  const VIPER = oid(), MAXX = oid(), BIO = oid();
  const dealer = (id) => {
    const d = { [D1]: ['Krishna Agro', 'Nashik', 'Ramesh'], [D2]: ['Krishna Agro', 'Pune', 'Suresh'],
      [D3]: ['Green Field', 'Satara', 'Mahesh'], [D4]: ['Empty Farm Supply', 'Sangli', 'Ganesh'] }[id];
    return { dealerId: id, dealerFirmSnapshot: d[0], dealerNameSnapshot: d[0], dealerPlaceSnapshot: d[1], dealerPersonSnapshot: d[2] };
  };
  const fp = (productId, productName, quantity, productUnit = 'L') => ({ productId, productName, productUnit, quantity });
  const sale = (productId, productName, quantity, salesValue, nbvValue, productUnit = 'L') =>
    ({ _id: oid(), productId, productName, productUnit, quantity, quantityValue: quantity, productPrice: salesValue / quantity,
      productNbvPercentage: 100 * nbvValue / salesValue, salesValue, nbvValue });
  const sub = (employee, day, extra) => ({
    _id: oid(), employee, date: new Date(`2026-10-${day}T00:00:00Z`), submitted: true, templateType: 'custom',
    customKind: 'calling', reviewStatus: 'reviewed', customResponses: [{ key: 'dialedCalls', value: 5 }],
    productSales: [], farmerRecords: [], ...extra,
  });
  const farmer = (name, mobile, d, products) => ({ _id: oid(), name, mobile, village: 'V', ...(d ? dealer(d) : {}), products });

  await db.collection('submissions').insertMany([
    // emp1, 05 Oct: spec example at D1 + a farmer linked to D4 with no products + an UNLINKED sale.
    sub(emp1, '05', {
      productSales: [sale(VIPER, 'VIPER', 0.4, 400, 40), sale(MAXX, 'MAXX TRICHO', 0.8, 800, 80), sale(VIPER, 'VIPER', 0.6, 600, 60), sale(VIPER, 'VIPER', 5, 5000, 500)],
      farmerRecords: [
        farmer('Farmer One',   '9000000001', D1, [fp(VIPER, 'VIPER', 0.4), fp(MAXX, 'MAXX TRICHO', 0.8)]),
        farmer('Farmer Two',   '9000000002', D1, [fp(VIPER, 'VIPER', 0.6)]),
        farmer('Farmer Three', '9000000003', D4, []),
        // free-text dealer only: must NOT be attributed to "Krishna Agro"
        { _id: oid(), name: 'Farmer Free', mobile: '9000000004', dealerLocation: 'Krishna Agro', products: [fp(VIPER, 'VIPER', 5)] },
      ],
    }),
    // emp2, 06 Oct: D2 (same firm name, other place); D3 mixed units, float sums, legacy id-less rows.
    sub(emp2, '06', {
      productSales: [sale(VIPER, 'VIPER', 2, 2000, 200), sale(BIO, 'BIO GROW', 1, 300, 30, 'KG')],
      farmerRecords: [
        farmer('Farmer Four', '9000000005', D2, [fp(VIPER, 'VIPER', 2)]),
        farmer('Farmer Five', '9000000006', D3, [fp(BIO, 'BIO GROW', 1, 'KG'), fp(BIO, 'BIO GROW', 0.5, 'L'), fp(VIPER, 'VIPER', 0.5)]),
        farmer('Farmer Six',  '9000000007', D3, [
          { productName: 'Neem Oil', productUnit: 'L', quantity: 0.1 },
          { productName: 'Neem Oil', productUnit: 'L', quantity: 0.2 },
          { productName: 'viper',    productUnit: 'L', quantity: 0.25 },
          { productName: 'Micro Mix', productUnit: 'L', quantity: 0.00004 },
        ]),
      ],
    }),
    // emp3 is in department B: invisible to the department-A HOD.
    sub(emp3, '07', { productSales: [sale(VIPER, 'VIPER', 7, 7000, 700)], farmerRecords: [farmer('Farmer B', '9000000008', D1, [fp(VIPER, 'VIPER', 7)])] }),
    // Excluded for everybody by default: test data, unreviewed, out of range.
    sub(emp1, '08', { isTestData: true, productSales: [sale(VIPER, 'VIPER', 9, 9000, 900)], farmerRecords: [farmer('T', '9', D1, [fp(VIPER, 'VIPER', 9)])] }),
    sub(emp1, '09', { reviewStatus: 'pending', productSales: [sale(VIPER, 'VIPER', 11, 1, 1)], farmerRecords: [farmer('P', '9', D1, [fp(VIPER, 'VIPER', 11)])] }),
    { ...sub(emp1, '01', {}), date: new Date('2026-09-15T00:00:00Z'), productSales: [sale(VIPER, 'VIPER', 13, 1, 1)], farmerRecords: [farmer('O', '9', D1, [fp(VIPER, 'VIPER', 13)])] },
    // November regression: saved Product Sales quantities conflict with the approved purchases.
    { ...sub(emp1, '04', {
      productSales: [sale(VIPER, 'VIPER', 2, 3500, 1750), sale(MAXX, 'MAXX TRICHO', 2, 125, 25)],
      farmerRecords: [
        farmer('Split A', '1', D1, [fp(VIPER, 'VIPER', 10), fp(MAXX, 'MAXX TRICHO', 1)]),
        farmer('Split B', '2', D2, [fp(VIPER, 'VIPER', 5), fp(MAXX, 'MAXX TRICHO', 1)]),
        farmer('Unlinked', '3', null, [fp(VIPER, 'VIPER', 1)]),
      ],
    }), date: new Date('2026-11-04T00:00:00Z') },
  ]);

  const catalogueId = oid();
  const quantityId = oid();
  await db.collection('products').insertOne({ _id: catalogueId, name: 'Price History', unit: 'L', pricePerUnit: 900, nbvPercentage: 50 });
  await db.collection('quantities').insertOne({ _id: quantityId, value: 0.25, unit: 'L' });
  const purchaseSubmission = {
    productSales: [{ productId: catalogueId, productUnit: 'L', productPrice: 765, productNbvPercentage: 100, quantity: 2.25, salesValue: 1721.25 }],
    farmerRecords: [
      { productId: catalogueId, productName: 'Price History', quantityId },
      { products: [{ productId: catalogueId, productUnit: 'L', quantity: 1, productPrice: 700, productNbvPercentage: 25 }] },
    ],
  };
  const catalogueFallback = { farmerRecords: [{ products: [{ productId: catalogueId, quantity: 2 }] }] };
  await valueFarmerPurchases([purchaseSubmission, catalogueFallback]);
  const valued = (s) => s.farmerRecords.flatMap((f) => f.products).map((row) => [row.quantity, row.salesValue, row.nbvValue]);
  assert.deepStrictEqual(valued(purchaseSubmission), [[0.25, 191.25, 191.25], [1, 700, 175]]);
  assert.deepStrictEqual(valued(catalogueFallback), [[2, 1800, 900]]);
  ok('historical farmer quantities and pricing are resolved with saved purchase rates, historical rates, and catalogue fallback');

  const HR  = { _id: oid(), role: 'hr' };
  const HOD = { _id: oid(), role: 'employee', isHOD: true, hodDepartment: deptA };
  const newDealer = await run(dealers.createDealer, HR, {}, {
    body: { firmName: 'Workbook Test Dealer', place: 'Test Place', dealerName: 'Test Person', state: ' wb ' },
  });
  assert.strictEqual(newDealer.statusCode, 201);
  assert.strictEqual(newDealer.body.state, 'WB');
  const editState = (state) => run(dealers.updateDealer, HR, {}, { params: { id: newDealer.body._id }, body: { state } });
  await assert.rejects(editState('MH'), (err) => err.statusCode === 400 && /STATE/.test(err.message));
  assert.strictEqual((await editState('')).body.state, '');
  assert.strictEqual((await editState('UP')).body.state, 'UP');
  ok('dealer create and edit normalize, validate and clear optional state');

  const importRows = (rows) => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Dealers');
    return run(dealers.importBulk, HR, {}, { file: { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) } });
  };
  const basicHeader = ['Firm Name', 'Place', 'Dealer Name'];
  const header = [...basicHeader, 'STATE'];
  const existingRow = ['Workbook Test Dealer', 'Test Place', 'Test Person'];
  await importRows([basicHeader, existingRow]);
  await importRows([header, [...existingRow, '']]);
  assert.strictEqual((await db.collection('dealers').findOne({ _id: newDealer.body._id })).state, 'UP');
  const result = (await importRows([header, [...existingRow, ' cg '], [], ['Invalid State Dealer', 'Test Place', 'Test Person', 'MH'], ['New Dealer Without State', 'Test Place', 'Test Person', '']])).body;
  assert.deepStrictEqual([result.createdCount, result.updatedCount, result.failedCount], [1, 1, 1]);
  assert.strictEqual(result.failed[0].row, 4);
  assert.match(result.failed[0].reason, /STATE/);
  assert.strictEqual((await db.collection('dealers').findOne({ _id: newDealer.body._id })).state, 'CG');
  assert.strictEqual((await db.collection('dealers').findOne({ firmName: 'New Dealer Without State' })).state, '');
  ok('imports keep existing state for blank or missing cells, save allowed codes, and report invalid rows');

  for (const handler of [dealers.importSample, dealers.exportDealers]) {
    const { body } = await run(handler, HR, {});
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(body);
    const ws = wb.getWorksheet('Dealers');
    assert.deepStrictEqual(ws.getRow(1).values.slice(1), header);
    assert.deepStrictEqual(ws.getCell('D2').dataValidation.formulae, ['"MP,UP,WB,CG"']);
    assert.strictEqual(ws.getCell('D2').dataValidation.allowBlank, true);
    assert.ok(wb.getWorksheet('Instructions'));
    if (handler === dealers.exportDealers) {
      const rows = ws.getSheetValues().filter(Boolean);
      assert.strictEqual(rows.find((r) => r[1] === existingRow[0])[4], 'CG');
      assert.strictEqual(rows.find((r) => r[1] === 'Green Field')[4], '');
      const result = (await run(dealers.importBulk, HR, {}, { file: { buffer: body } })).body;
      assert.strictEqual(result.failedCount, 0);
      // The existing import intentionally reactivates dealers. Restore the test fixture.
      await db.collection('dealers').updateOne({ _id: D2 }, { $set: { active: false } });
    }
  }
  ok('sample and dealer export contain the optional STATE dropdown; export can be reimported');
  const OCT = { from: '2026-10-01', to: '2026-10-31' };
  const json = async (user, q) => (await run(analytics.callingAnalytics, user, q)).body;
  const book = async (user, q) => {
    const res = await run(analytics.exportCallingAnalytics, user, q);
    assert.match(res.headers['content-type'], /spreadsheetml/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    return wb;
  };
  const byFirm = (rows) => Object.fromEntries(rows.map((d) => [`${d.firmName}|${d.place}`, d]));
  const dataRows = (ws) => {
    const out = [];
    ws.eachRow((row, i) => { if (i >= 4) out.push(row.values.slice(1)); });
    return out;
  };

  const splitDate = { from: '2026-11-04', to: '2026-11-04' };
  const splitData = await json(HR, splitDate);
  const splitMoney = (rows) => rows.map(({ sales, nbv }) => [sales, nbv]);
  assert.deepStrictEqual(splitMoney(splitData.dealersTable), [[17562.50, 8762.50], [8812.50, 4387.50]]);
  assert.deepStrictEqual(splitMoney(splitData.dealerDayRows).sort(), splitMoney(splitData.dealersTable).sort());
  assert.deepStrictEqual(splitMoney(splitData.dealerTrend), [[26375, 13150]]);
  assert.deepStrictEqual(splitMoney(splitData.productsTable), [[28000, 14000], [125, 25]]);
  const splitBook = await book(HR, splitDate);
  assert.deepStrictEqual(dataRows(splitBook.getWorksheet('Per-Dealer Breakdown')).map((row) => row.slice(8)), splitMoney(splitData.dealersTable));
  assert.strictEqual(splitData.productKpis.totalQuantitySold, 18);
  const employeeSale = [...splitBook.getWorksheet('Calling Analytics').getSheetValues()].find((row) => row?.[1] === 'VIPER');
  assert.deepStrictEqual(employeeSale.slice(2, 5), [16, 28000, 14000]);
  ok('approved farmer purchases determine quantity, sales and NBV in every Excel sheet and daily trends despite conflicting legacy quantities');

  /* --- screen payload (HOD of department A) --- */
  const hodData = await json(HOD, OCT);
  const T = byFirm(hodData.dealersTable);
  assert.strictEqual(T['Krishna Agro|Nashik'].productSummary, 'VIPER(1), MAXX TRICHO(0.8)');
  assert.strictEqual(T['Krishna Agro|Pune'].productSummary, 'VIPER(2)');
  ok('HOD view: Dealer A "VIPER(1), MAXX TRICHO(0.8)"; same firm name at another place stays separate "VIPER(2)"');
  assert.strictEqual(T['Green Field|Satara'].productSummary, 'BIO GROW(1 KG), VIPER(0.75), BIO GROW(0.5 L), Neem Oil(0.3), Micro Mix(0.00004)');
  ok('mixed units stay separate, legacy rows merge, and tiny quantities stay visible');
  assert.strictEqual(T['Empty Farm Supply|Sangli'].productSummary, '—');
  assert.deepStrictEqual([T['Green Field|Satara'].sales, T['Green Field|Satara'].nbv], [800, 80]);
  ok('dealer with linked farmer but no products -> em dash');
  assert.ok(!JSON.stringify(hodData.dealersTable.map((d) => d.productSummary)).includes('(5)'), 'unlinked free-text sale not attributed');
  assert.strictEqual(hodData.dealersTable.length, 4);
  ok('unlinked / free-text dealer sale is not attributed to any dealer');
  // Dealer amounts come from the farmer's purchase rows, independent of other farmers.
  assert.deepStrictEqual(
    ['farmers', 'products', 'qty', 'sales', 'nbv'].map((k) => T['Krishna Agro|Nashik'][k]),
    [2, 3, 1.8, 1800, 180]);
  assert.deepStrictEqual(['farmers', 'products', 'qty'].map((k) => T['Empty Farm Supply|Sangli'][k]), [1, 0, 0]);
  ok('dealer metrics use only linked purchases; farmer rows without products still count toward Farmers');

  /* --- export matches screen (HOD) --- */
  const wb = await book(HOD, OCT);
  assert.deepStrictEqual(wb.worksheets.map((w) => w.name), ['Calling Analytics', 'Per-Product Breakdown', 'Per-Dealer Breakdown']);
  ok('one workbook: original "Calling Analytics" sheet + Per-Product + Per-Dealer sheets');
  const ps = wb.getWorksheet('Per-Product Breakdown');
  const dsh = wb.getWorksheet('Per-Dealer Breakdown');
  assert.deepStrictEqual(ps.getRow(3).values.slice(1), ['Product', 'Rows', 'Quantity', 'Sales (₹)', 'NBV (₹)']);
  assert.deepStrictEqual(dsh.getRow(3).values.slice(1),
    ['Firm Name', 'Place', 'Dealer Name', 'STATE', 'Farmers', 'Products', 'Product', 'Quantity', 'Sales (₹)', 'NBV (₹)']);
  assert.match(String(ps.getCell('A2').value), /Date Range: 01-Oct-2026 to 31-Oct-2026/);
  assert.match(String(dsh.getCell('A2').value), /Date Range: 01-Oct-2026 to 31-Oct-2026/);
  ok('headers in the required column order; date range shown on both new sheets');
  assert.deepStrictEqual(dataRows(ps), hodData.productsTable.map((p) => [p.name, p.rows, p.qty, p.sales, p.nbv]));
  assert.deepStrictEqual(dataRows(dsh), hodData.dealersTable.map((d) =>
    [d.firmName, d.place, d.dealerName, d.state, d.farmers, d.products, d.productSummary, d.qty, d.sales, d.nbv]));
  assert.strictEqual(dataRows(dsh).find((r) => r[1] === 'Nashik')[3], 'MP');
  assert.strictEqual(dataRows(dsh).find((r) => r[1] === 'Pune')[3], 'CG');
  assert.strictEqual(dataRows(dsh).find((r) => r[1] === 'Satara')[3], '');
  ok('Per-Dealer export uses current master state for active and inactive dealers and leaves older records blank');
  ok(`rows, order and values identical to the screen (${hodData.productsTable.length} products, ${hodData.dealersTable.length} dealers)`);
  const nums = [...dataRows(ps).flatMap((r) => r.slice(1)), ...dataRows(dsh).flatMap((r) => [r[4], r[5], r[7], r[8], r[9]])];
  assert.ok(nums.every((v) => typeof v === 'number'), 'numeric cells');
  assert.ok(dataRows(dsh).every((r) => typeof r[6] === 'string'), 'Product is text');
  assert.strictEqual(dsh.getCell('I4').numFmt, '"₹"#,##0.00');
  assert.ok(dsh.getCell('G4').alignment.wrapText && dsh.getColumn(7).width >= 40);
  const sumSales = dataRows(dsh).reduce((s, r) => s + r[8], 0);
  assert.strictEqual(Math.round(sumSales * 100) / 100, hodData.dealersTable.reduce((s, d) => s + d.sales, 0));
  ok('counts / quantity / Sales / NBV stored as numbers (summable); Product is wrapped plain text');
  const flat = JSON.stringify([...dataRows(ps), ...dataRows(dsh)]);
  for (const pii of ['Farmer One', '9000000001', 'Farmer Free']) assert.ok(!flat.includes(pii), `no ${pii}`);
  ok('no farmer names or phone numbers in the new sheets');

  /* --- scope: HOD cannot widen, HR sees everything --- */
  const hodOther = await json(HOD, { ...OCT, department: String(deptB) });
  assert.strictEqual(byFirm(hodOther.dealersTable)['Krishna Agro|Nashik'].productSummary, 'VIPER(1), MAXX TRICHO(0.8)');
  const hodOtherWb = await book(HOD, { ...OCT, department: String(deptB), includeTest: 'true' });
  assert.ok(!JSON.stringify(dataRows(hodOtherWb.getWorksheet('Per-Dealer Breakdown'))).includes('VIPER(8)'));
  assert.ok(!JSON.stringify(dataRows(hodOtherWb.getWorksheet('Per-Dealer Breakdown'))).includes('VIPER(10)'));
  ok("HOD ?department=<other> and ?includeTest are ignored: no other department's or test data in the export");
  const hrData = await json(HR, OCT);
  assert.strictEqual(byFirm(hrData.dealersTable)['Krishna Agro|Nashik'].productSummary, 'VIPER(8), MAXX TRICHO(0.8)');
  const hrTest = await json(HR, { ...OCT, includeTest: 'true' });
  assert.strictEqual(byFirm(hrTest.dealersTable)['Krishna Agro|Nashik'].productSummary, 'VIPER(17), MAXX TRICHO(0.8)');
  const hrTestWb = await book(HR, { ...OCT, includeTest: 'true' });
  assert.ok(dataRows(hrTestWb.getWorksheet('Per-Dealer Breakdown')).some((r) => r[6] === 'VIPER(17), MAXX TRICHO(0.8)'));
  ok('HR: full org (VIPER 8); authorized includeTest adds test data on screen and in the export (VIPER 17); unreviewed + out-of-range never counted');
  await assert.rejects(() => run(analytics.exportCallingAnalytics, { _id: oid(), role: 'employee' }, OCT), (e) => /restricted to HR/.test(e.message));
  ok('plain employee: export handler refuses (route gate requireAnalyticsAccess also blocks first)');

  /* --- filters change screen and export together --- */
  const emp2Only = { ...OCT, employee: String(emp2) };
  const e2 = await json(HR, emp2Only);
  const e2wb = await book(HR, emp2Only);
  assert.deepStrictEqual(e2.dealersTable.map((d) => d.place).sort(), ['Pune', 'Satara']);
  assert.deepStrictEqual(dataRows(e2wb.getWorksheet('Per-Dealer Breakdown')).map((r) => r[1]), e2.dealersTable.map((d) => d.place));
  const day6 = { from: '2026-10-06', to: '2026-10-06' };
  const d6 = await json(HR, day6);
  const d6wb = await book(HR, day6);
  assert.deepStrictEqual(dataRows(d6wb.getWorksheet('Per-Dealer Breakdown')).map((r) => r[6]), d6.dealersTable.map((d) => d.productSummary));
  assert.match(String(d6wb.getWorksheet('Per-Dealer Breakdown').getCell('A2').value), /06-Oct-2026 to 06-Oct-2026/);
  assert.ok(!d6.dealersTable.some((d) => d.place === 'Nashik'));
  ok('employee filter and date range narrow the screen and the export identically');

  /* --- empty range -> valid workbook with headers --- */
  const empty = await book(HR, { from: '2026-01-01', to: '2026-01-31' });
  assert.strictEqual(empty.worksheets.length, 3);
  for (const nm of ['Per-Product Breakdown', 'Per-Dealer Breakdown']) {
    const w = empty.getWorksheet(nm);
    assert.ok(w.getRow(3).values.length > 1, `${nm} headers`);
    assert.strictEqual(dataRows(w).length, 0);
  }
  ok('empty range: valid 3-sheet workbook, headers present, no data rows');

  /* --- drill-down payloads untouched --- */
  assert.ok(Array.isArray(hodData.dealerDayRows) && hodData.dealerDayRows.every((r) => !('productSummary' in r)));
  assert.ok(hodData.productsTable.every((p) => Object.keys(p).sort().join() === 'name,nbv,qty,rows,sales'));
  ok('productsTable rows and dealer drill-down rows keep their original shape');

  const submissionController = require('../submissionController');
  const templateId = oid();
  const submissionId = oid();
  const { startOfDay, formatYMD } = require('../../utils/dateHelpers');
  const today = startOfDay();
  await db.collection('templates').insertOne({
    _id: templateId, title: 'Purchase-only Report', templateType: 'custom', customKind: 'product_farmer',
    customSections: ['farmerRecords'], customFields: [],
  });
  await db.collection('submissions').insertOne({
    _id: submissionId, employee: emp1, template: templateId, date: today,
    templateType: 'custom', customKind: 'product_farmer', submitted: false,
  });
  const actor = { _id: emp1, name: 'Test Submitter', role: 'super_admin' };
  const purchaseBody = {
    farmerRecords: [{ name: 'New Purchase', dealerId: D1, products: [{ productId: catalogueId, quantity: 0.25 }] }],
    productSales: [{ productId: catalogueId, quantity: 99 }],
    selfRating: 7,
  };
  const submitExtras = { params: { id: submissionId }, body: purchaseBody };
  await run(submissionController.saveDraft, actor, {}, submitExtras);
  const savedDraft = await db.collection('submissions').findOne({ _id: submissionId });
  assert.strictEqual(savedDraft.farmerRecords[0].products[0].productPrice, 900);
  assert.strictEqual(savedDraft.productSales?.length || 0, 0);
  await run(submissionController.submitOne, actor, {}, submitExtras);
  await db.collection('products').updateOne({ _id: catalogueId }, { $set: { pricePerUnit: 1000, nbvPercentage: 100 } });
  const todayData = await json(HR, { from: formatYMD(today), to: formatYMD(today) });
  const newPurchase = todayData.productsTable.find((row) => row.name === 'Price History');
  assert.deepStrictEqual([newPurchase.qty, newPurchase.sales, newPurchase.nbv], [0.25, 225, 112.50]);
  ok('draft, submit and analytics use purchase rows only and keep their saved prices after catalogue changes');

  await db.dropDatabase();
  await mongoose.disconnect();
};

(async () => {
  pure();
  let Server;
  try { ({ MongoMemoryServer: Server } = require('mongodb-memory-server')); }
  catch (e) { console.log('SKIPPED (DB part): mongodb-memory-server is not installed.'); return; }
  let sa;
  try { sa = await Server.create(); }
  catch (e) {
    console.log(`SKIPPED (DB part): could not start a disposable mongod (${String(e.message).split('\n')[0]}).`);
    return;
  }
  const log = console.log;
  try {
    console.log = (...a) => { if (!String(a[0]).startsWith('[analytics]')) log(...a); };
    await suite(sa.getUri());
    log(`\n  ${n} calling dealer-product / export checks passed`);
  } finally {
    console.log = log;
    await sa.stop();
  }
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
