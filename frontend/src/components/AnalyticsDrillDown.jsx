import Modal from './Modal.jsx';

/**
 * AnalyticsDrillDown - reusable building blocks for the dual-mode
 * Performance analytics: a metric-explanation registry, an explanation
 * panel, a clickable card wrapper, and a drill-down modal that pairs the
 * explanation with a data breakdown.  Designed so new metrics only need a
 * registry entry + a breakdown renderer - no architectural change.
 */

/**
 * Every metric's plain-language explanation: what it measures, why it
 * matters, and how to read high / normal / low values.
 */
export const METRIC_INFO = {
  // ---- Pendency mode ----
  avgPendencyRate: {
    title: 'Average Pendency Rate',
    meaning: 'The share of explicitly-submitted work currently marked Pending — pending ÷ (pending + done). Work Not Available, unsubmitted, and hidden rows are excluded.',
    why: 'It is the headline measure of operational bottlenecks and unfinished work across the team.',
    high: 'High (≥50%) signals overload, blockers, or a stalled workflow needing attention.',
    normal: 'Normal is roughly 10–25% — a healthy amount of in-progress work.',
    low: 'Low (<10%) means work is being closed quickly.',
  },
  totalPendingTasks: {
    title: 'Total Pending Tasks',
    meaning: 'The raw count of submitted rows an employee explicitly marked Pending in the selected period.',
    why: 'Shows the absolute volume of unfinished work, independent of team size.',
    high: 'A large pendency concentrated in few people indicates uneven load.',
    normal: 'Trending flat or downward day-over-day is healthy.',
    low: 'Few pending tasks means work is closing on time.',
  },
  dependencyBlocked: {
    title: 'Dependency Blocked',
    meaning: 'Open dependency hand-offs — work an employee finished on their side but that now waits on someone else.',
    why: 'These are cross-team blockers; they often hide the real cause of delays.',
    high: 'Many open dependencies points to coordination or capacity problems downstream.',
    normal: 'A few open hand-offs is expected in collaborative work.',
    low: 'Few or none means hand-offs are being resolved promptly.',
  },
  resolvedVsUnresolved: {
    title: 'Resolved vs Unresolved Dependencies',
    meaning: 'How many dependency hand-offs have been resolved versus still open.',
    why: 'A resolution-focused view of collaborative throughput.',
    high: 'A high resolved share means the team clears hand-offs reliably.',
    normal: 'Most should resolve within their turnaround window.',
    low: 'A growing unresolved count is an early warning of bottlenecks.',
  },
  mostPendingDepartment: {
    title: 'Most Pending Department',
    meaning: 'The department carrying the highest volume of pending work in the period.',
    why: 'Pinpoints where to focus load-balancing or process help.',
    high: '—', normal: '—', low: '—',
  },
  mostDelayedEmployee: {
    title: 'Most Delayed Employee',
    meaning: 'The employee whose oldest pending item has been waiting the longest.',
    why: 'Surfaces the most aged blocker so it can be unblocked first.',
    high: 'Long waits (15d+) need direct follow-up.',
    normal: 'Items resolved within a week are healthy.',
    low: '—',
  },
  // ---- Completion mode ----
  avgCompletionScore: {
    title: 'Average Completion Score',
    meaning: 'Reviewer-awarded marks normalised against total available marks — earned ÷ total across task, excel, spreadsheet, cell scoring plus discipline and innovation.',
    why: 'The headline measure of completion quality, not just whether work was submitted.',
    high: 'High (≥80%) reflects strong, well-reviewed output.',
    normal: 'Normal is roughly 60–80%.',
    low: 'Low (<60%) suggests quality gaps or incomplete work.',
  },
  avgQualityRating: {
    title: 'Average Quality Rating',
    meaning: 'Reviewer-awarded marks normalised against the maximum possible — the quality lens on completed work.',
    why: 'Distinguishes "done" from "done well".',
    high: 'High means reviewers consistently rate the work strongly.',
    normal: 'Mid-range indicates acceptable but improvable quality.',
    low: 'Low flags coaching or rework needs.',
  },
  mostConsistentEmployee: {
    title: 'Most Consistent Employee',
    meaning: 'The employee with the steadiest scores across submissions (lowest variation).',
    why: 'Consistency is a strong predictor of dependable performance.',
    high: '—', normal: '—', low: '—',
  },
  highestScoringDepartment: {
    title: 'Highest Scoring Department',
    meaning: 'The department with the best average completion score.',
    why: 'Highlights teams worth learning best practices from.',
    high: '—', normal: '—', low: '—',
  },
  fastestResolver: {
    title: 'Fastest Resolver',
    meaning: 'The person who resolves dependency hand-offs in the shortest average time.',
    why: 'Identifies reliable unblockers for collaborative work.',
    high: '—', normal: '—', low: '—',
  },
  mostCollaborativeEmployee: {
    title: 'Most Collaborative Employee',
    meaning: 'The employee involved in the most dependency hand-offs (given + received).',
    why: 'Shows who is most embedded in cross-team workflows.',
    high: '—', normal: '—', low: '—',
  },
  onTimeSubmissionRate: {
    title: 'On-time Submission Rate',
    meaning: 'The share of submissions made on or before their assigned day (not cleared late from pendency).',
    why: 'Timeliness is a core discipline metric.',
    high: 'High (≥90%) reflects strong punctuality.',
    normal: 'Normal is roughly 75–90%.',
    low: 'Low indicates chronic lateness or overload.',
  },
  avgReviewMarks: {
    title: 'Average Review Marks',
    meaning: 'The average finalized marks awarded per reviewed submission.',
    why: 'A quick gauge of typical reviewed output value.',
    high: '—', normal: '—', low: '—',
  },
  avgDisciplineScore: {
    title: 'Average Discipline Score',
    meaning: 'Discipline marks awarded by reviewers, normalised against the max discipline marks.',
    why: 'Captures punctuality, neatness and process adherence as scored by reviewers.',
    high: 'High reflects strong professional discipline.',
    normal: 'Mid-range is typical.',
    low: 'Low suggests discipline coaching is needed.',
  },
  reviewApprovalRate: {
    title: 'Review Approval Rate',
    meaning: 'The share of submitted work that has been reviewed and finalized.',
    why: 'Measures review throughput — how much work has been closed out by reviewers.',
    high: 'High means reviews are keeping pace with submissions.',
    normal: '—',
    low: 'Low means a review pendency is building.',
  },
  // ---- Charts (generic) ----
  completionTrend: {
    title: 'Completion Trend',
    meaning: 'Day-by-day average completion score over the period.',
    why: 'Reveals whether quality is improving, steady, or declining.',
    high: 'A rising line is positive momentum.', normal: 'Flat is stable.', low: 'A falling line warrants investigation.',
  },
  pendencyTrend: {
    title: 'Pendency Trend',
    meaning: 'Day-by-day count of pending units over the period.',
    why: 'Shows whether the pendency is growing or shrinking.',
    high: 'A rising line means pendency is accumulating.', normal: 'Flat/low is healthy.', low: 'A falling line is positive.',
  },
  // ---- Assignment analytics ----
  mostUsedTemplates: {
    title: 'Most Used Templates',
    meaning: 'Templates with the largest number of active assignments across the org.',
    why: 'Reveals which work definitions actually drive day-to-day output.',
    high: '—', normal: '—', low: '—',
  },
  highestPendency: {
    title: 'Templates with Highest Pendency',
    meaning: 'Templates with the largest share of pending units across recent submissions.',
    why: 'Identifies the work definitions most prone to accumulating pendency.',
    high: '—', normal: '—', low: '—',
  },
  highestCompletion: {
    title: 'Highest Completion Templates',
    meaning: 'Templates with the highest done-share across recent submissions.',
    why: 'Shows which work runs smoothly and could serve as a process model.',
    high: '—', normal: '—', low: '—',
  },
  departmentLoad: {
    title: 'Department Assignment Load',
    meaning: 'Active assignments resolved to each department (direct + via designation + via employees).',
    why: 'Spots departments carrying disproportionate workload.',
    high: '—', normal: '—', low: '—',
  },
  employeeLoad: {
    title: 'Employee Assignment Load',
    meaning: 'Active assignments that apply to each employee (direct + inherited).',
    why: 'Spots employees with disproportionate assignment counts.',
    high: '—', normal: '—', low: '—',
  },
  overdueAssignmentCount: {
    title: 'Overdue Assignments',
    meaning: 'Assignments with at least one pending task older than 7 days.',
    why: 'A direct measure of stuck work that needs follow-up.',
    high: 'High counts call for direct intervention.', normal: '—', low: 'Low is healthy.',
  },
  dependencyHeavyTemplates: {
    title: 'Dependency-Heavy Templates',
    meaning: 'Templates that have spawned the most cross-team dependency hand-offs.',
    why: 'Pinpoints work that frequently requires collaboration to finish.',
    high: '—', normal: '—', low: '—',
  },
  // ---- Dependency analytics (Phase 23.4) ----
  avgResolutionTime: {
    title: 'Average Resolution Time',
    meaning: 'The mean wall-clock time (hours) between a dependent task being shared and being resolved.',
    why: 'Measures how quickly the team unblocks each other on hand-off work.',
    high: 'High averages signal slow collaboration or stuck owners.',
    normal: 'A few hours to a day is typical for well-tracked work.',
    low: 'Low means hand-offs are being picked up promptly.',
  },
  collaborativeCompletion: {
    title: 'Collaborative Completion',
    meaning: 'Percentage of all dependent tasks that have been resolved — resolved ÷ total transferred.',
    why: 'A health signal for how reliably hand-offs reach closure.',
    high: 'A high share means most collaboration finishes successfully.',
    normal: '—',
    low: 'A low share indicates accumulating open hand-offs.',
  },
  dependentWork: {
    title: 'Dependent Work',
    meaning: 'Aggregate view of every transferred dependent task in the org — totals for transferred, resolved, and resolution rate.',
    why: 'Headline measure of cross-team collaboration volume and follow-through.',
    high: 'A high resolution rate signals reliable hand-off completion.',
    normal: '—',
    low: 'A low rate means transferred work is not closing out.',
  },
  openDependencies: {
    title: 'Open Dependencies',
    meaning: 'The count of dependent tasks that are still open or in progress (not yet resolved).',
    why: 'Direct measure of cross-team work waiting on someone.',
    high: 'A growing open count is an early warning of bottlenecks.',
    normal: '—',
    low: 'Low means hand-offs clear quickly.',
  },
  // ---- Calling Analytics drill-downs (Phase 25) ----
  callAssigned: {
    title: 'Assigned Calls',
    meaning: 'The total number of calls handed out to the team across the selected period.',
    why: 'Headline measure of the call queue the team was asked to work through.',
    high: '—', normal: '—', low: '—',
  },
  callCompleted: {
    title: 'Calls Completed',
    meaning: 'Unique-customer calls the team finished (reached, attempted-and-closed, or otherwise resolved).',
    why: 'Throughput of the calling operation against the assigned queue.',
    high: '—', normal: '—', low: '—',
  },
  callDialed: {
    title: 'Dialed Calls',
    meaning: 'Raw dial attempts, including retries on customers that didn’t pick up the first time.',
    why: 'Effort signal: how many call attempts the team made.',
    high: '—', normal: '—', low: '—',
  },
  callAttended: {
    title: 'Attended Calls',
    meaning: 'Dial attempts that were picked up by the customer.',
    why: 'Connection success measured against dial attempts.',
    high: '—', normal: '—', low: '—',
  },
  callUnattended: {
    title: 'Unattended Calls',
    meaning: 'Dial attempts that were not answered.',
    why: 'Highlights customers who need a follow-up window.',
    high: '—', normal: '—', low: '—',
  },
  callConversions: {
    title: 'Conversions',
    meaning: 'Calls that ended in a customer conversion, split into Old vs New customer types.',
    why: 'The revenue-relevant outcome of the calling effort.',
    high: '—', normal: '—', low: '—',
  },
  callPending: {
    title: 'Pending Calls',
    meaning: 'Open work the team still owes the customer: current pending + carry-forward from previous day.',
    why: 'Backlog the team has to clear; growing pending = effort outpaced by inbound.',
    high: 'A rising pending count is an early warning of overload.',
    normal: '—',
    low: 'Low pending means the queue is being cleared promptly.',
  },
  callConnectionRate: {
    title: 'Connection Rate',
    meaning: 'Attended ÷ Dialed. The share of dial attempts the customer picked up.',
    why: 'Pure connection effectiveness, independent of conversion quality.',
    high: 'High means the team is reaching customers reliably.',
    normal: '—',
    low: 'Low signals timing / list-quality problems.',
  },
  callConversionRate: {
    title: 'Conversion Rate',
    meaning: 'Conversions ÷ Attended. Of the customers who picked up, how many converted.',
    why: 'Sales effectiveness once a call is connected.',
    high: 'High reflects strong closing skills.',
    normal: '—',
    low: 'Low signals coaching or pitch issues.',
  },
  callPendingRate: {
    title: 'Pending Rate',
    meaning: 'Pending ÷ Assigned. The share of the assigned queue still outstanding.',
    why: 'Workload completion gap, normalised against assignment size.',
    high: 'A high pending rate signals over-allocation or under-performance.',
    normal: '—',
    low: 'Low means the team is closing out their assigned work.',
  },
  callCompletionRate: {
    title: 'Call Completion Rate',
    meaning: 'Calls Completed ÷ Assigned. Headline throughput against the assignment.',
    why: 'How much of the assigned queue was actually finished.',
    high: 'High = the team finished what they were given.',
    normal: '—',
    low: 'Low = a large chunk of the queue is still open or abandoned.',
  },
  callLeaderboard: {
    title: 'Calling Leaderboard',
    meaning: 'Full ranking of every employee in scope on the selected metric, not just the top five visible on the card.',
    why: 'Lets HR / HOD audit the entire ranking and find people just outside the visible top.',
    high: '—', normal: '—', low: '—',
  },
  // ---- Product & Farmer drill-downs (Phase 25.1) ----
  pfTotalProducts: {
    title: 'Total Products Sold',
    meaning: 'Org-wide product-sale rows in the period, broken down by product with employee contributions.',
    why: 'Catalogue traction view: which products move, and which employees move them.',
    high: '—', normal: '—', low: '—',
  },
  pfTotalQuantity: {
    title: 'Total Quantity Sold',
    meaning: 'Sum of quantity moved across every product-sale row, broken down by (employee, product, date).',
    why: 'Volume signal independent of price.',
    high: '—', normal: '—', low: '—',
  },
  pfTotalSales: {
    title: 'Total Sales Value',
    meaning: 'Sum of sales value across all product-sale rows, with the (employee, product, date) drill below.',
    why: 'Revenue contribution from product sales tied to the calling effort.',
    high: '—', normal: '—', low: '—',
  },
  pfTotalNbv: {
    title: 'Total NBV Value',
    meaning: 'Sum of NBV across all product-sale rows, with the (employee, product, date) drill below.',
    why: 'Margin signal: net business value contribution.',
    high: '—', normal: '—', low: '—',
  },
  pfTotalFarmers: {
    title: 'Total Farmers Added',
    meaning: 'Every farmer record in scope with employee + dealer attribution + product list.',
    why: 'Audit of who was added and through which dealer.',
    high: '—', normal: '—', low: '—',
  },
  pfRevenuePerCall: {
    title: 'Revenue / Call',
    meaning: 'Employee ranking of revenue divided by calls completed.',
    why: 'Effort-normalised revenue performance.',
    high: '—', normal: '—', low: '—',
  },
  pfNbvPerCall: {
    title: 'NBV / Call',
    meaning: 'Employee ranking of NBV divided by calls completed.',
    why: 'Effort-normalised margin performance.',
    high: '—', normal: '—', low: '—',
  },
  pfFarmersPerEmployee: {
    title: 'Farmers / Employee',
    meaning: 'Per-employee count of farmers added (with product + revenue context).',
    why: 'Reach effectiveness of each employee in onboarding farmers.',
    high: '—', normal: '—', low: '—',
  },
  pfEmployeeLeaderboard: {
    title: 'Top Employees — Product & Farmer',
    meaning: 'Full ranking of employees on the selected Product & Farmer metric.',
    why: 'Audit the whole ranking, not just the top five.',
    high: '—', normal: '—', low: '—',
  },
  pfProduct: {
    title: 'Product Detail',
    meaning: 'Per-product breakdown: dealers, farmers and employees who moved this product.',
    why: 'Audit one product\'s full distribution profile in the period.',
    high: '—', normal: '—', low: '—',
  },
  // ---- Dealer Analytics drill-downs (Phase 25.1) ----
  dealerActive: {
    title: 'Total Active Dealers',
    meaning: 'The full active Dealer Master roster.',
    why: 'Inventory check of the dealer network -- regardless of activity in range.',
    high: '—', normal: '—', low: '—',
  },
  dealerCovered: {
    title: 'Dealers Covered',
    meaning: 'Dealers that had at least one farmer recorded against them in the range.',
    why: 'Coverage signal: which dealers are being worked.',
    high: '—', normal: '—', low: '—',
  },
  dealerWithSales: {
    title: 'Dealers With Sales',
    meaning: 'Dealers whose farmer records mapped to a sales line in the range.',
    why: 'Revenue contribution by dealer.',
    high: '—', normal: '—', low: '—',
  },
  dealerAvgSales: {
    title: 'Avg Sales / Dealer',
    meaning: 'Per-dealer revenue with average across the covered set.',
    why: 'Sales spread across dealers.',
    high: '—', normal: '—', low: '—',
  },
  dealerLeaderboard: {
    title: 'Top Dealers',
    meaning: 'Full dealer ranking on the selected metric.',
    why: 'Audit the whole list, not just the top five.',
    high: '—', normal: '—', low: '—',
  },
  dealerProfile: {
    title: 'Dealer Profile',
    meaning: 'Per-dealer profile: firm + place + employees + farmers + products + date-wise activity.',
    why: 'Complete picture of one dealer in the chosen period.',
    high: '—', normal: '—', low: '—',
  },
  // ---- Template Analytics drill-downs (Phase 30) ----
  ta_submissions: {
    title: 'Submissions',
    meaning: 'Every live, reviewed submission for this template in scope. One row per submission with employee + date + score.',
    why: 'Backing dataset behind the Submissions count and Submission Rate.',
    high: '—', normal: '—', low: '—',
  },
  ta_submissionRate: {
    title: 'Submission Rate',
    meaning: 'Submitted ÷ Generated. The list below is the submitted side; the generated counter sits in the Overview card.',
    why: 'See which submissions actually came in versus the assignments that were due.',
    high: '—', normal: '—', low: '—',
  },
  ta_completionRate: {
    title: 'Completion Rate',
    meaning: 'Sum of earned ÷ sum of total points across every submission. Drill shows the per-submission contribution.',
    why: 'Spot the submissions pulling the overall completion up or down.',
    high: '—', normal: '—', low: '—',
  },
  ta_doneRate: {
    title: 'Done Rate',
    meaning: 'Share of task rows resolved as Done or Ongoing.',
    why: 'See exactly which tasks landed in the resolved bucket.',
    high: '—', normal: '—', low: '—',
  },
  ta_pendingRate: {
    title: 'Pending Rate',
    meaning: 'Share of task rows currently Pending.',
    why: 'See exactly which tasks are pending — and why.',
    high: '—', normal: '—', low: '—',
  },
  ta_wnaRate: {
    title: 'Work N/A Rate',
    meaning: 'Share of task rows marked Work Not Available.',
    why: 'Audit which tasks were declared not applicable.',
    high: '—', normal: '—', low: '—',
  },
  ta_tasksDone: {
    title: 'Tasks Done',
    meaning: 'All task rows resolved as Done or Ongoing in scope.',
    why: 'Per-record visibility of completed task rows.',
    high: '—', normal: '—', low: '—',
  },
  ta_tasksPending: {
    title: 'Tasks Pending',
    meaning: 'All task rows currently marked Pending in scope.',
    why: 'Per-record visibility of unresolved task rows.',
    high: '—', normal: '—', low: '—',
  },
  ta_tasksWNA: {
    title: 'Tasks Unavailable',
    meaning: 'All task rows marked Work Not Available in scope.',
    why: 'Per-record visibility of declared-not-applicable rows.',
    high: '—', normal: '—', low: '—',
  },
  ta_task: {
    title: 'Task Detail',
    meaning: 'Records contributing to one row of the Task Status table — filtered to the chosen task title and status.',
    why: 'Inspect the per-record values behind one cell of the Task Status table.',
    high: '—', normal: '—', low: '—',
  },
  ta_field: {
    title: 'Field Detail',
    meaning: 'Records contributing to one numeric field analytics card — per (employee, date) values, optionally narrowed by employee or department.',
    why: 'Inspect every value behind a Total / Avg / Min / Max KPI.',
    high: '—', normal: '—', low: '—',
  },
  ta_extra: {
    title: 'Extra Work Detail',
    meaning: 'Employee-added task rows in scope, optionally filtered by status, employee, department, or title.',
    why: 'Audit ad-hoc work logged by employees.',
    high: '—', normal: '—', low: '—',
  },
  ta_employee: {
    title: 'Employee Detail',
    meaning: 'Submission history + task breakdown + per-field values for one employee in scope.',
    why: 'Full per-employee picture without leaving the analytics page.',
    high: '—', normal: '—', low: '—',
  },
  recurrenceDistribution: {
    title: 'Recurring vs One-time',
    meaning: 'Mix of assignment recurrence types (daily / weekly / monthly / one-time).',
    why: 'Shows whether the org runs on cadence or ad-hoc work.',
    high: '—', normal: '—', low: '—',
  },
};

/** Explanation panel shown at the top of every drill-down. */
export function MetricInfo({ id }) {
  const info = METRIC_INFO[id];
  if (!info) return null;
  const Line = ({ label, children, cls }) => (
    <div className="flex gap-2 text-sm">
      <span className={`shrink-0 font-semibold ${cls || 'text-slate-500'}`}>{label}</span>
      <span className="text-slate-600">{children}</span>
    </div>
  );
  return (
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1.5">
      <Line label="What it measures:">{info.meaning}</Line>
      <Line label="Why it matters:">{info.why}</Line>
      {info.high && info.high !== '—' && <Line label="High:" cls="text-red-600">{info.high}</Line>}
      {info.normal && info.normal !== '—' && <Line label="Normal:" cls="text-amber-600">{info.normal}</Line>}
      {info.low && info.low !== '—' && <Line label="Low:" cls="text-green-600">{info.low}</Line>}
    </div>
  );
}

/** Clickable wrapper that gives any analytics block hover + cursor affordance. */
export function ClickableCard({ onClick, children, className = '' }) {
  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick?.(); }}
      className={`cursor-pointer transition hover:-translate-y-0.5 hover:shadow-md rounded-2xl focus:outline-none focus:ring-2 focus:ring-brand-400 ${className}`}
      title="Click for details"
    >
      {children}
    </div>
  );
}

/** Drill-down modal: explanation + data breakdown (passed as children). */
export function DrillDownModal({ metricId, title, onClose, children }) {
  const info = METRIC_INFO[metricId];
  return (
    <Modal open onClose={onClose} size="xl" title={title || info?.title || 'Details'}
      footer={<button className="btn-secondary" onClick={onClose}>Close</button>}>
      <div className="space-y-4">
        <MetricInfo id={metricId} />
        {children}
      </div>
    </Modal>
  );
}
