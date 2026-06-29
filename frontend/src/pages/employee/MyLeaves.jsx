import { useEffect, useState } from 'react';
import api from '../../api/axios';
import Modal from '../../components/Modal.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { fmtDate, errMsg } from '../../utils/helpers';
import { useAuth } from '../../context/AuthContext.jsx';
import { subscribe } from '../../realtime';

export default function MyLeaves() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const toast = useToast();
  const { user } = useAuth();

  const load = async () => {
    setLoading(true);
    const { data } = await api.get('/leaves/mine');
    setItems(data);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);
  // Phase 47 -- HR approves / rejects -> my leave list refreshes.
  useEffect(() => subscribe('leave:decision', load), []);

  const apply = async (form) => {
    try {
      await api.post('/leaves', form);
      toast.success('Leave applied');
      setModal(null);
      load();
    } catch (err) { toast.error(errMsg(err)); }
  };

  const remaining = (user?.leaveBalance?.yearlyAllowance || 0) - (user?.leaveBalance?.used || 0);

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">My Leaves</h1>
          <p className="text-sm text-slate-500">Balance: <b>{remaining}</b> of {user?.leaveBalance?.yearlyAllowance || 0} remaining</p>
        </div>
        <button className="btn-primary" onClick={() => setModal({
          fromDate: new Date().toISOString().substring(0, 10),
          toDate: new Date().toISOString().substring(0, 10),
          leaveType: 'casual', reason: '', dayType: 'full',
        })}>+ Apply Leave</button>
      </div>

      <div className="card overflow-x-auto">
        {loading ? <Loader /> :
          items.length === 0 ? <EmptyState title="No leave history" /> :
          <table className="table">
            <thead><tr><th>Applied</th><th>Type</th><th>From</th><th>To</th><th>Days</th><th>Status</th><th>Note</th></tr></thead>
            <tbody>
              {items.map((lv) => (
                <tr key={lv._id}>
                  <td>{fmtDate(lv.createdAt)}</td>
                  <td className="capitalize">{lv.leaveType}</td>
                  <td>{fmtDate(lv.fromDate)}</td>
                  <td>{fmtDate(lv.toDate)}</td>
                  <td>
                    {lv.days}
                    {lv.dayType === 'half' && <span className="ml-1 badge-amber">Half Day</span>}
                  </td>
                  <td>
                    {lv.status === 'pending' && <span className="badge-amber">Pending</span>}
                    {lv.status === 'approved' && <span className={lv.paid ? 'badge-green' : 'badge-amber'}>{lv.paid ? 'Approved' : 'Approved (Unpaid)'}</span>}
                    {lv.status === 'rejected' && <span className="badge-red">Rejected</span>}
                  </td>
                  <td className="text-slate-500">{lv.hrNote || lv.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>}
      </div>

      {modal && (
        <Modal open onClose={() => setModal(null)} title="Apply for Leave"
          footer={<>
            <button className="btn-secondary" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn-primary" onClick={() => apply(modal)}>Submit</button>
          </>}>
          <div className="space-y-3">
            <div><label className="label">Leave Type</label>
              <select className="input" value={modal.leaveType} onChange={(e) => setModal({ ...modal, leaveType: e.target.value })}>
                <option value="casual">Casual</option><option value="sick">Sick</option>
                <option value="paid">Paid</option><option value="unpaid">Unpaid</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">From</label><input className="input" type="date" value={modal.fromDate} onChange={(e) => {
                const fromDate = e.target.value;
                // Half-day is only valid for a single-day request.
                const dayType = fromDate === modal.toDate ? modal.dayType : 'full';
                setModal({ ...modal, fromDate, dayType });
              }} /></div>
              <div><label className="label">To</label><input className="input" type="date" value={modal.toDate} onChange={(e) => {
                const toDate = e.target.value;
                const dayType = modal.fromDate === toDate ? modal.dayType : 'full';
                setModal({ ...modal, toDate, dayType });
              }} /></div>
            </div>

            {/* Full / Half day option appears ONLY for single-day requests. */}
            {modal.fromDate && modal.fromDate === modal.toDate && (
              <div>
                <label className="label">Duration</label>
                <select className="input" value={modal.dayType} onChange={(e) => setModal({ ...modal, dayType: e.target.value })}>
                  <option value="full">Full Day Leave</option>
                  <option value="half">Half Day Leave (0.5 day)</option>
                </select>
                {modal.dayType === 'half' && (
                  <p className="text-xs text-slate-500 mt-1">
                    You'll still receive daily tasks and are expected to work the other half of the day.
                  </p>
                )}
              </div>
            )}

            <div><label className="label">Reason</label>
              <textarea className="input" rows={3} value={modal.reason} onChange={(e) => setModal({ ...modal, reason: e.target.value })} />
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
