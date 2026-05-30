import { useEffect, useState } from 'react';
import api from '../../api/axios';
import Collapsible from '../../components/Collapsible.jsx';
import Modal from '../../components/Modal.jsx';
import { Loader, EmptyState } from '../../components/Loader.jsx';
import ScheduleTag from '../../components/ScheduleTag.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { delayBadgeClass, delayLabel, errMsg, fmtDate } from '../../utils/helpers';

/**
 * Global Backlog (HR view)
 *
 * Adds two "send notification" entry points on top of the existing view:
 *   - Group-level "Send Alert" - notifies the employee about their entire
 *     backlog list.
 *   - Per-row "Notify" - notifies the employee about that single task.
 *
 * Both open the same composer modal with pre-filled title + message,
 * which HR can freely edit before sending.
 */
export default function GlobalBacklog() {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [alert, setAlert] = useState(null); // { employee, tasks }
  const toast = useToast();

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/dashboard/hr/backlog');
      setGroups(data);
    } catch (err) { toast.error(errMsg(err)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  if (loading) return <Loader />;

  const overdueCount = groups.filter((g) => g.backlog.some((b) => b.daysPending >= 2)).length;
  const totalTasks = groups.reduce((s, g) => s + g.count, 0);

  // Helper - open the composer pre-filled for an employee + selected tasks
  const openAlert = (employee, tasks) => {
    const titles = tasks.map((t) => t.title);
    const taskIds = tasks.map((t) => t.taskId);
    const isOne = tasks.length === 1;
    const defaultMsg = isOne
      ? `Hi ${employee.name}, please complete your pending task "${tasks[0].title}" as soon as possible. It has been pending for ${delayLabel(tasks[0].daysPending).toLowerCase()}.`
      : `Hi ${employee.name}, please clear your pending work:\n${titles.map((t) => `  • ${t}`).join('\n')}\n\nLet me know if anything is blocking you.`;
    setAlert({
      employee,
      relatedTaskIds: taskIds,
      relatedTitles: titles,
      title: isOne ? 'Pendency reminder' : 'Pendency reminder - multiple tasks',
      message: defaultMsg,
    });
  };

  const sendAlert = async () => {
    try {
      await api.post('/notifications', {
        recipients: [alert.employee._id],
        title: alert.title,
        message: alert.message,
        type: 'backlog_alert',
        relatedTaskIds: alert.relatedTaskIds,
        relatedTitles: alert.relatedTitles,
      });
      toast.success(`Alert sent to ${alert.employee.name}`);
      setAlert(null);
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Global Pendency</h1>
        <p className="text-sm text-slate-500">
          {groups.length} employees with pendency • {totalTasks} total task(s) • {overdueCount} overdue (2+ days)
        </p>
      </div>

      {groups.length === 0 && <EmptyState title="No pendency company-wide" subtitle="Everyone is up to date - great work!" />}

      {groups.map((g) => (
        <Collapsible key={g.employee._id}
          title={g.employee.name}
          subtitle={`${g.employee.department?.name || 'No dept'} • ${g.count} pending`}
          right={
            <div className="flex items-center gap-2">
              <span className={g.count >= 3 ? 'badge-red' : 'badge-amber'}>{g.count}</span>
              <button
                className="btn-secondary !py-1 !px-3 text-xs"
                onClick={() => openAlert(g.employee, g.backlog)}
              >
                Send Alert
              </button>
            </div>
          }
        >
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Task</th><th>Template</th><th>Reason</th><th>Pending since</th><th>Delay</th><th></th></tr></thead>
              <tbody>
                {g.backlog.map((b) => (
                  <tr key={`${b.submissionId}-${b.taskId}`}>
                    <td className="font-medium">{b.title}</td>
                    <td>{b.templateTitle}<div className="mt-0.5"><ScheduleTag frequency={b.frequency} label={b.scheduleLabel} /></div></td>
                    <td className="text-slate-500">{b.pendingReason}</td>
                    <td>{fmtDate(b.pendingSince)}</td>
                    <td><span className={delayBadgeClass(b.daysPending)}>{delayLabel(b.daysPending)}</span></td>
                    <td className="text-right">
                      <button
                        className="btn-ghost text-xs"
                        onClick={() => openAlert(g.employee, [b])}
                      >
                        Notify
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Collapsible>
      ))}

      {alert && (
        <Modal
          open
          onClose={() => setAlert(null)}
          title={`Send alert to ${alert.employee.name}`}
          footer={<>
            <button className="btn-secondary" onClick={() => setAlert(null)}>Cancel</button>
            <button className="btn-primary" onClick={sendAlert}>Send Alert</button>
          </>}
        >
          <div className="space-y-3">
            <div>
              <label className="label">Subject</label>
              <input
                className="input"
                value={alert.title}
                onChange={(e) => setAlert({ ...alert, title: e.target.value })}
              />
            </div>
            <div>
              <label className="label">Message</label>
              <textarea
                className="input"
                rows={6}
                value={alert.message}
                onChange={(e) => setAlert({ ...alert, message: e.target.value })}
              />
            </div>
            {alert.relatedTitles?.length > 0 && (
              <div className="bg-slate-50 rounded-lg p-3 text-xs text-slate-600">
                <div className="font-semibold mb-1">Referenced task{alert.relatedTitles.length !== 1 ? 's' : ''}:</div>
                <ul className="list-disc pl-5">
                  {alert.relatedTitles.map((t, i) => <li key={i}>{t}</li>)}
                </ul>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
