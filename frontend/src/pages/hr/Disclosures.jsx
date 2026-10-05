import { useEffect, useState } from 'react';
import api from '../../api/axios';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import SearchableSelect from '../../components/SearchableSelect.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg } from '../../utils/helpers';
import { DISCLOSURE_TYPES, typeLabel } from '../../utils/disclosure';

const PAGE_SIZE = 50;
const NA = <span className="text-slate-400">—</span>;
// Business dates are UTC-midnight; format from the ISO string so the
// browser timezone can never shift the day.
const fmtBizDate = (d) => {
  const s = d ? String(d).slice(0, 10) : '';
  const [y, m, day] = s.split('-');
  return y ? `${day}/${m}/${y}` : '—';
};
const yn = (v) => (v === true ? 'Yes' : v === false ? 'No' : NA);
const TYPE_BADGE = { mistake: 'badge-amber', exception: 'badge-blue', other: 'badge-gray' };

export default function Disclosures() {
  const toast = useToast();
  const [employees, setEmployees] = useState([]);
  const [date, setDate] = useState('');
  const [employee, setEmployee] = useState('');
  const [type, setType] = useState('all');
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0, pages: 1 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/employees').then((r) => setEmployees(Array.isArray(r.data) ? r.data : [])).catch(() => {});
  }, []);

  // Any filter change returns to page 1.
  useEffect(() => { setPage(1); }, [date, employee, type]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = { page, limit: PAGE_SIZE };
    if (date) params.date = date;
    if (employee) params.employee = employee;
    if (type !== 'all') params.type = type;
    api.get('/disclosures', { params })
      .then((r) => { if (!cancelled) setData(r.data); })
      .catch((err) => { if (!cancelled) toast.error(errMsg(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [date, employee, type, page]);

  const clear = () => { setDate(''); setEmployee(''); setType('all'); };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Disclosure</h1>
        <p className="text-sm text-slate-500">Mistakes, exceptions and other disclosures employees filed with their daily work. Review only — no penalty or score is applied.</p>
      </div>

      <div className="card card-body grid md:grid-cols-4 gap-3 items-end">
        <div>
          <label className="label">Date</label>
          <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label className="label">Employee</label>
          <SearchableSelect
            value={employee} onChange={setEmployee} options={employees}
            getValue={(e) => e._id}
            getLabel={(e) => `${e.name} (${e.employeeId})`}
            getSearchText={(e) => `${e.name} ${e.employeeId} ${e.email || ''}`}
            placeholder="All employees" />
        </div>
        <div>
          <label className="label">Disclosure Type</label>
          <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="all">All</option>
            {DISCLOSURE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        <div><button className="btn-secondary" onClick={clear}>Clear filters</button></div>
      </div>

      <div className="card overflow-x-auto">
        {loading ? <Loader /> : data.items.length === 0 ? <EmptyState title="No disclosures found" /> : (
          <table className="table">
            <thead><tr>
              <th>Date</th><th>Employee</th><th>Type</th><th>Details</th>
              <th>Correctable</th><th>Corrected</th><th>Authorized By</th>
            </tr></thead>
            <tbody>
              {data.items.map((d) => (
                <tr key={d._id}>
                  <td className="whitespace-nowrap text-sm">{fmtBizDate(d.date)}</td>
                  <td className="text-sm font-medium">{d.employee?.name || '—'}<div className="text-[11px] text-slate-500">{d.employee?.employeeId}</div></td>
                  <td><span className={TYPE_BADGE[d.type] || 'badge-gray'}>{typeLabel(d.type)}</span></td>
                  <td className="text-sm max-w-md whitespace-pre-wrap break-words">{d.details}</td>
                  <td>{d.type === 'mistake' ? yn(d.correctable) : NA}</td>
                  <td>{d.type === 'mistake' && d.correctable === true ? yn(d.corrected) : NA}</td>
                  <td className="text-sm">{d.type === 'exception' ? (d.authorizedBy || NA) : NA}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex items-center justify-between text-sm text-slate-600">
        <span>{data.total} disclosure{data.total === 1 ? '' : 's'}</span>
        <div className="flex items-center gap-2">
          <button className="btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
          <span>Page {page} of {data.pages}</span>
          <button className="btn-secondary" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      </div>
    </div>
  );
}
