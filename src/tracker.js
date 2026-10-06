// Business rules: statuses, what counts as "delayed", and who should hear about it.
const { todayISO, isoInTZ, daysBetween, addDays } = require('./dates');

// Status list matches the drop-down in the reference workbook.
const STATUSES = ['TBD', 'Not Started', 'In Progress', 'Blocked', 'On Hold', 'Completed'];
const BRICKS = ['TOFU', 'MOFU', 'BOFU'];
const CHANNELS = ['App', 'Web', 'Loan Journey'];
const MEETING_TYPES = ['POD stand-up', 'Stakeholder review', 'Business', 'IT / Tech', 'Vendor / Partner', 'Field research', 'Other'];
const DONE = new Set(['Completed']);

// A task is delayed when its due date has passed and it is not completed.
// "Blocked" items are flagged separately so they also reach the team.
function delayInfo(item, today = todayISO()) {
  if (!item.dueDate || DONE.has(item.status) || item.status === 'Done') return { overdue: false, daysLate: 0 };
  const late = daysBetween(item.dueDate, today);
  return { overdue: late > 0, daysLate: Math.max(0, late), dueToday: late === 0 };
}

function decorateTask(t, today) {
  return { ...t, ...delayInfo(t, today) };
}

// SPOC is free text such as "Asha / Ravi". Match each name to a team member.
function splitNames(spoc) {
  return String(spoc || '').split(/\s*(?:\/|,|&|\band\b)\s*/i).map(s => s.trim()).filter(Boolean);
}

function findMember(team, name) {
  const n = name.toLowerCase();
  return team.find(m => m.name.toLowerCase() === n)
    || team.find(m => m.name.toLowerCase().split(/\s+/)[0] === n.split(/\s+/)[0]);
}

function spocMembers(team, spoc) {
  return splitNames(spoc).map(n => findMember(team, n)).filter(Boolean);
}

function emails(members) {
  return [...new Set(members.map(m => (m.email || '').trim()).filter(Boolean))];
}

// Open MOM action items, flattened, with their meeting for context.
function actionItems(db, today = todayISO()) {
  const out = [];
  for (const m of db.meetings) {
    (m.actionItems || []).forEach((a, i) => {
      out.push({ ...a, ...delayInfo({ dueDate: a.dueDate, status: a.status }, today), meetingId: m.id, meetingTitle: m.title, meetingDate: m.date, index: i });
    });
  }
  return out;
}

function counts(tasks) {
  const c = Object.fromEntries(STATUSES.map(s => [s, 0]));
  for (const t of tasks) c[t.status] = (c[t.status] || 0) + 1;
  return c;
}

// Everything the 6 PM email (and the dashboard) needs.
function buildSummary(db, today = todayISO()) {
  const tasks = db.tasks.map(t => decorateTask(t, today));
  const soon = addDays(today, 3);
  const touchedToday = new Map();
  for (const a of db.activity) {
    if (isoInTZ(a.at) !== today) continue;
    if (a.type === 'task' && a.id != null) {
      const prev = touchedToday.get(a.id);
      if (!prev) touchedToday.set(a.id, { ...a, changes: [...(a.changes || [])] });
      else prev.changes.unshift(...(a.changes || []));
    }
  }
  const updatedToday = [...touchedToday.values()]
    .map(a => ({ activity: a, task: tasks.find(t => t.id === a.id) }))
    .filter(x => x.task);
  const items = actionItems(db, today);
  return {
    today,
    total: tasks.length,
    counts: counts(tasks),
    completion: tasks.length ? Math.round((counts(tasks).Completed / tasks.length) * 100) : 0,
    overdue: tasks.filter(t => t.overdue).sort((a, b) => b.daysLate - a.daysLate),
    blocked: tasks.filter(t => t.status === 'Blocked'),
    dueToday: tasks.filter(t => t.dueToday),
    dueSoon: tasks.filter(t => !t.overdue && !t.dueToday && t.dueDate && t.dueDate <= soon && t.status !== 'Completed')
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    completedToday: updatedToday.filter(x => x.task.status === 'Completed' && x.activity.changes.some(c => c.field === 'status')).map(x => x.task),
    updatedToday,
    noDueDate: tasks.filter(t => !t.dueDate && t.status !== 'Completed').length,
    meetingsToday: db.meetings.filter(m => m.date === today),
    overdueActions: items.filter(a => a.overdue),
    openActions: items.filter(a => a.status !== 'Done'),
    byBrick: BRICKS.map(b => {
      const bt = tasks.filter(t => t.brick === b);
      return { brick: b, total: bt.length, done: bt.filter(t => t.status === 'Completed').length, overdue: bt.filter(t => t.overdue).length };
    }),
  };
}

module.exports = {
  STATUSES, BRICKS, CHANNELS, MEETING_TYPES,
  delayInfo, decorateTask, splitNames, findMember, spocMembers, emails, actionItems, buildSummary,
};
