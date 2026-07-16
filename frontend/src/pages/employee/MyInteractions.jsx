import { useEffect, useState } from 'react';
import api from '../../api/axios';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { errMsg, fmtDate } from '../../utils/helpers';

/**
 * Employee-side "My Interactions" -- lists every meeting the employee
 * is invited to plus any interaction / note explicitly marked
 * Employee Visible.  Accept / Decline / Maybe buttons record the
 * employee's INTENTION; final attendance is HR's authority.
 */
const INV_LABEL = { invited: 'Invited', accepted: 'Accepted', declined: 'Declined', maybe: 'Maybe' };
const TYPE_META = {
  meeting: '📅 Meeting', personal_note: '📝 Note', warning: '⚠️ Warning',
  appreciation: '⭐ Appreciation', follow_up: '🔁 Follow-up', coaching: '🎯 Coaching',
  performance_discussion: '📊 Performance', salary_discussion: '💰 Salary',
  training: '🎓 Training', probation_review: '🗓 Probation', exit_discussion: '🚪 Exit',
  other: '💬 Other',
};

export default function MyInteractions() {
  const toast = useToast();
  const { user } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api.get('/interactions/mine')
      .then(({ data }) => setRows(data || []))
      .catch((err) => toast.error(errMsg(err)))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const respond = async (id, status) => {
    try { await api.post(`/interactions/${id}/respond`, { status }); load(); }
    catch (err) { toast.error(errMsg(err)); }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">My Interactions</h1>
        <p className="text-sm text-slate-500">Every meeting you're invited to and every interaction shared with you.</p>
      </div>
      {loading ? <Loader /> : rows.length === 0 ? (
        <EmptyState title="No interactions yet" />
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const myPart = (r.participants || []).find((p) => String(p.employee) === String(user?._id) || String(p.employee?._id) === String(user?._id));
            const inv = myPart?.invitationStatus || 'invited';
            return (
              <div key={r._id} className="card card-body">
                <div className="flex items-start justify-between flex-wrap gap-2">
                  <div className="min-w-0">
                    <div className="text-[11px] text-slate-500">{TYPE_META[r.type] || '💬 Other'} · {r.createdBy?.name || 'HR'}</div>
                    <div className="text-sm font-semibold text-slate-800">{r.title}</div>
                    <div className="text-[11px] text-slate-500">
                      {r.meeting?.date ? fmtDate(r.meeting.date) : fmtDate(r.createdAt)}
                      {r.meeting?.time && <> · {r.meeting.time}</>}
                      {r.meeting?.location && <> · 📍 {r.meeting.location}</>}
                    </div>
                    {r.description && <div className="text-sm text-slate-700 mt-1 whitespace-pre-wrap">{r.description}</div>}
                  </div>
                  {r.type === 'meeting' && (
                    <div className="flex flex-col items-end gap-1">
                      <span className="badge text-[11px] border bg-slate-50 text-slate-600 border-slate-200">{INV_LABEL[inv]}</span>
                      <div className="flex gap-1">
                        <button className="btn-primary !py-1 !text-xs" onClick={() => respond(r._id, 'accepted')}>Accept</button>
                        <button className="btn-secondary !py-1 !text-xs" onClick={() => respond(r._id, 'maybe')}>Maybe</button>
                        <button className="btn-ghost !py-1 !text-xs" onClick={() => respond(r._id, 'declined')}>Decline</button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
