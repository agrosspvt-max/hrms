// Reproduces the exact math the new controller runs, against the spec's
// worked examples.  No DB — pure arithmetic verification.
const safePct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

// ------------ Spec example #1 (task-level) ----------------
// Task points = 10; 15 Done, 3 Pending, 2 Work N/A.
// Expected: Total = 180, Earned = 150.
{
  const p = 10, done = 15, pending = 3, wna = 2;
  const totalPoints  = (done + pending) * p;   // WNA excluded
  const earnedPoints = done * p;
  const applicable   = done + pending;
  const donePct    = safePct(done, applicable);
  const pendingPct = safePct(pending, applicable);
  console.log('Spec ex #1:  totalPoints=', totalPoints, '(exp 180) earned=', earnedPoints, '(exp 150) done%=', donePct, 'pending%=', pendingPct);
}

// ------------ Spec example #2 (percentages) ----------------
// Done=40, Pending=10, WNA=50.  Old: 40/100=40%.  New: 40/50=80%.
{
  const done = 40, pending = 10, wna = 50;
  const applicable = done + pending;
  const donePct = safePct(done, applicable);
  const pendingPct = safePct(pending, applicable);
  const wnaPct = safePct(wna, done + pending + wna);
  console.log('Spec ex #2:  done%=', donePct, '(exp 80) pending%=', pendingPct, '(exp 20) wna% still fine=', wnaPct);
}

// ------------ Spec example #3 (applicable) -----------------
// Assigned=100, WNA=30 -> Applicable=70.  Done=50, Pending=20.
// Done%=50/70~=71.4, Pending%=20/70~=28.6.
{
  const done = 50, pending = 20, wna = 30;
  const applicable = done + pending;
  console.log('Spec ex #3:  applicable=', applicable, '(exp 70) done%=', safePct(done, applicable),
    '(exp ~71.4) pending%=', safePct(pending, applicable), '(exp ~28.6)');
}

// ------------ Overall score (points across many tasks) ------
// Three tasks, points [10, 20, 5].
// Task A(10): 3 Done, 1 Pending, 1 WNA  -> total 40, earned 30
// Task B(20): 1 Done, 2 Pending, 3 WNA  -> total 60, earned 20
// Task C(5):  4 Done, 0 Pending, 2 WNA  -> total 20, earned 20
// Available = 40+60+20 = 120.  Earned = 30+20+20 = 70.  Score = 58.3%.
{
  const tasks = [
    { p: 10, d: 3, pn: 1, w: 1 },
    { p: 20, d: 1, pn: 2, w: 3 },
    { p: 5,  d: 4, pn: 0, w: 2 },
  ];
  let avail = 0, earned = 0;
  for (const t of tasks) { avail += (t.d + t.pn) * t.p; earned += t.d * t.p; }
  console.log('Multi-task:  available=', avail, '(exp 120) earned=', earned, '(exp 70) score%=', safePct(earned, avail), '(exp 58.3)');
}
