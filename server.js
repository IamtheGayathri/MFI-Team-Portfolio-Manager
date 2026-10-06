// MFI Project Tracker — shared team website.
// Run: npm install && npm start, then open http://localhost:3000
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const store = require('./src/store');
const notify = require('./src/notifications');
const mailer = require('./src/mailer');
const { buildWorkbook } = require('./src/excel');
const { STATUSES, BRICKS, CHANNELS, MEETING_TYPES, decorateTask, buildSummary, delayInfo } = require('./src/tracker');
const { TZ, todayISO } = require('./src/dates');

try { process.loadEnvFile?.(path.join(__dirname, '.env')); } catch { /* no .env file */ }

store.load();
const app = express();
app.use(express.json({ limit: '2mb' }));

// Optional shared passcode for the whole team (HTTP Basic auth; any username).
const PASSCODE = process.env.TEAM_PASSCODE;
if (PASSCODE) {
  app.use((req, res, next) => {
    const [, b64] = (req.headers.authorization || '').split(' ');
    const pass = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
    const a = Buffer.from(pass), b = Buffer.from(PASSCODE);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
    res.set('WWW-Authenticate', 'Basic realm="MFI Project Tracker"').status(401).send('Team passcode required');
  });
}

app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
const user = req => {
  try { return decodeURIComponent(req.get('X-User') || '').slice(0, 80) || 'Unknown'; } catch { return 'Unknown'; }
};
const str = (v, max = 4000) => (v == null ? '' : String(v).slice(0, max).trim());
const date = v => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '');
const oneOf = (v, list, dflt) => (list.includes(v) ? v : dflt);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

const TASK_FIELDS = {
  brick: ['Brick', v => oneOf(v, BRICKS, 'TOFU')],
  channel: ['Channel', v => oneOf(v, CHANNELS, 'App')],
  workstream: ['Workstream', v => str(v, 200)],
  task: ['Task', v => str(v)],
  status: ['Status', v => oneOf(v, STATUSES, 'TBD')],
  spoc: ['SPOC', v => str(v, 200)],
  outcome: ['Linked outcome', v => str(v, 500)],
  ticket: ['Ticket', v => str(v, 200)],
  startDate: ['Start date', date],
  dueDate: ['Due date', date],
  remarks: ['Remarks', v => str(v)],
};

function cleanTask(body, base = {}) {
  const out = { ...base };
  for (const [k, [, fn]] of Object.entries(TASK_FIELDS)) if (k in body) out[k] = fn(body[k]);
  return out;
}

function cleanMeeting(b) {
  return {
    date: date(b.date) || todayISO(),
    time: str(b.time, 40),
    title: str(b.title, 200) || 'Untitled meeting',
    type: oneOf(b.type, MEETING_TYPES, 'Other'),
    attendees: str(b.attendees, 1000),
    agenda: str(b.agenda),
    notes: str(b.notes, 20000),
    decisions: str(b.decisions, 8000),
    nextMeeting: date(b.nextMeeting),
    actionItems: (Array.isArray(b.actionItems) ? b.actionItems : []).slice(0, 100)
      .map(a => ({ id: Number(a.id) || 0, text: str(a.text, 1000), owner: str(a.owner, 120), dueDate: date(a.dueDate),
        status: a.status === 'Done' ? 'Done' : 'Open', taskId: Number(a.taskId) || null }))
      .filter(a => a.text),
  };
}

function numberActions(items) {
  let next = items.reduce((m, a) => Math.max(m, a.id || 0), 0) + 1;
  for (const a of items) if (!a.id) a.id = next++;
  return items;
}

function stateFor() {
  const db = store.get();
  const today = todayISO();
  return {
    version: db.version,
    today,
    timeZone: TZ,
    meta: { statuses: STATUSES, bricks: BRICKS, channels: CHANNELS, meetingTypes: MEETING_TYPES },
    overview: db.overview,
    tasks: db.tasks.map(t => decorateTask(t, today)),
    dataPrepSteps: db.dataPrepSteps,
    dataCuts: db.dataCuts.map(d => ({ ...d, ...delayInfo(d, today) })),
    research: db.research,
    scope: db.scope,
    team: db.team,
    meetings: db.meetings.map(m => ({ ...m, actionItems: (m.actionItems || []).map(a => ({ ...a, ...delayInfo(a, today) })) })),
    settings: { ...notify.settings(), mailConfigured: mailer.configured() },
    summary: buildSummary(db, today),
  };
}

// ---------- read ----------
app.get('/api/state', (req, res) => res.json(stateFor()));
app.get('/api/version', (req, res) => res.json({ version: store.get().version }));
app.get('/api/activity', (req, res) => res.json(store.get().activity.slice(0, Math.min(Number(req.query.limit) || 200, 1000))));

app.get('/api/export.xlsx', async (req, res, next) => {
  try {
    const buf = await buildWorkbook(store.get());
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="MFI_Project_Tracker_${todayISO()}.xlsx"`,
    });
    res.send(Buffer.from(buf));
  } catch (e) { next(e); }
});

// ---------- tasks ----------
app.post('/api/tasks', (req, res) => {
  const t = cleanTask(req.body, { brick: 'TOFU', channel: 'App', workstream: '', task: '', status: 'TBD', spoc: '', outcome: '', ticket: '', startDate: '', dueDate: '', remarks: '' });
  if (!t.task) return bad(res, 'Task description is required');
  const created = store.mutate(user(req), nt => ({ type: 'task', action: 'created', id: nt.id, summary: `Added #${nt.id}: ${nt.task.slice(0, 80)}`, changes: [] }), db => {
    const nt = { id: store.nextId(db.tasks), ...t, updatedAt: new Date().toISOString(), updatedBy: user(req) };
    if (nt.status === 'Blocked') nt.blockedSince = nt.updatedAt;
    db.tasks.push(nt);
    return nt;
  });
  notify.checkSoon();
  res.status(201).json(created);
});

app.put('/api/tasks/:id', (req, res) => {
  const db = store.get();
  const t = db.tasks.find(x => x.id === Number(req.params.id));
  if (!t) return bad(res, 'Task not found', 404);
  // Simple conflict guard: refuse if someone else saved this task after the client loaded it.
  if (req.body._loadedAt && t.updatedAt && t.updatedAt > req.body._loadedAt && t.updatedBy !== user(req)) {
    return bad(res, `${t.updatedBy || 'Someone'} updated this task while you were editing. Reload to see their change.`, 409);
  }
  const next = cleanTask(req.body, t);
  const changes = Object.keys(TASK_FIELDS).filter(k => (t[k] ?? '') !== (next[k] ?? ''))
    .map(k => ({ field: k, label: TASK_FIELDS[k][0], from: t[k] ?? '', to: next[k] ?? '' }));
  if (!changes.length) return res.json(t);
  store.mutate(user(req), { type: 'task', action: 'updated', id: t.id, summary: `Updated #${t.id}`, changes }, () => {
    if (next.status === 'Blocked' && t.status !== 'Blocked') next.blockedSince = new Date().toISOString();
    if (next.status !== 'Blocked') delete next.blockedSince;
    Object.assign(t, next, { updatedAt: new Date().toISOString(), updatedBy: user(req) });
  });
  notify.checkSoon();
  res.json(t);
});

app.delete('/api/tasks/:id', (req, res) => {
  const id = Number(req.params.id);
  const t = store.get().tasks.find(x => x.id === id);
  if (!t) return bad(res, 'Task not found', 404);
  store.mutate(user(req), { type: 'task-deleted', action: 'deleted', id, summary: `Deleted #${id}: ${t.task.slice(0, 80)}` }, db => {
    db.tasks = db.tasks.filter(x => x.id !== id);
  });
  res.json({ ok: true });
});

// ---------- meetings / MOM ----------
app.post('/api/meetings', (req, res) => {
  const m = cleanMeeting(req.body);
  const created = store.mutate(user(req), { type: 'meeting', action: 'created', summary: `Added MOM: ${m.title}` }, db => {
    const nm = { id: store.nextId(db.meetings), ...m, actionItems: numberActions(m.actionItems), createdBy: user(req), createdAt: new Date().toISOString() };
    db.meetings.push(nm);
    return nm;
  });
  notify.checkSoon();
  res.status(201).json(created);
});

app.put('/api/meetings/:id', (req, res) => {
  const m = store.get().meetings.find(x => x.id === Number(req.params.id));
  if (!m) return bad(res, 'Meeting not found', 404);
  const next = cleanMeeting(req.body);
  store.mutate(user(req), { type: 'meeting', action: 'updated', summary: `Updated MOM: ${next.title}` }, () => {
    Object.assign(m, next, { actionItems: numberActions(next.actionItems), updatedAt: new Date().toISOString(), updatedBy: user(req) });
  });
  notify.checkSoon();
  res.json(m);
});

app.delete('/api/meetings/:id', (req, res) => {
  const id = Number(req.params.id);
  const m = store.get().meetings.find(x => x.id === id);
  if (!m) return bad(res, 'Meeting not found', 404);
  store.mutate(user(req), { type: 'meeting', action: 'deleted', summary: `Deleted MOM: ${m.title}` }, db => {
    db.meetings = db.meetings.filter(x => x.id !== id);
  });
  res.json({ ok: true });
});

// Turn a MOM action item into a tracker task (and link them).
app.post('/api/meetings/:id/actions/:aid/to-task', (req, res) => {
  const db = store.get();
  const m = db.meetings.find(x => x.id === Number(req.params.id));
  const a = m && (m.actionItems || []).find(x => x.id === Number(req.params.aid));
  if (!a) return bad(res, 'Action item not found', 404);
  if (a.taskId && db.tasks.some(t => t.id === a.taskId)) return bad(res, `Already linked to task #${a.taskId}`, 409);
  const t = cleanTask({ ...req.body, task: a.text, spoc: a.owner, dueDate: a.dueDate, status: 'Not Started', remarks: `From MOM: ${m.title} (${m.date})` },
    { brick: 'MOFU', channel: 'Loan Journey', workstream: '', outcome: '', ticket: '', startDate: todayISO() });
  const created = store.mutate(user(req), nt => ({ type: 'task', action: 'created', id: nt.id, summary: `Added #${nt.id} from MOM "${m.title}"`, changes: [] }), d => {
    const nt = { id: store.nextId(d.tasks), ...t, updatedAt: new Date().toISOString(), updatedBy: user(req) };
    d.tasks.push(nt);
    a.taskId = nt.id;
    return nt;
  });
  res.status(201).json(created);
});

// ---------- data cuts ----------
const CUT_FIELDS = ['cut', 'who', 'fields', 'output', 'period', 'owner', 'remarks'];
function cleanCut(b, base) {
  const out = { ...base };
  for (const k of CUT_FIELDS) if (k in b) out[k] = str(b[k], 1000);
  if ('status' in b) out.status = oneOf(b.status, STATUSES, 'TBD');
  if ('dueDate' in b) out.dueDate = date(b.dueDate);
  return out;
}
app.post('/api/datacuts', (req, res) => {
  const c = cleanCut(req.body, { cut: '', who: '', fields: '', output: '', period: '', status: 'TBD', owner: '', dueDate: '', remarks: '' });
  if (!c.cut) return bad(res, 'Data cut name is required');
  const created = store.mutate(user(req), { type: 'datacut', action: 'created', summary: `Added data cut: ${c.cut}` }, db => {
    const n = { id: store.nextId(db.dataCuts), ...c };
    db.dataCuts.push(n);
    return n;
  });
  res.status(201).json(created);
});
app.put('/api/datacuts/:id', (req, res) => {
  const c = store.get().dataCuts.find(x => x.id === Number(req.params.id));
  if (!c) return bad(res, 'Data cut not found', 404);
  store.mutate(user(req), { type: 'datacut', action: 'updated', summary: `Updated data cut: ${c.cut}` }, () => Object.assign(c, cleanCut(req.body, c)));
  res.json(c);
});
app.delete('/api/datacuts/:id', (req, res) => {
  const id = Number(req.params.id);
  store.mutate(user(req), { type: 'datacut', action: 'deleted', summary: `Deleted data cut #${id}` }, db => {
    db.dataCuts = db.dataCuts.filter(x => x.id !== id);
  });
  res.json({ ok: true });
});

// ---------- team & settings ----------
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
function cleanMember(b, base = {}) {
  const email = str(b.email ?? base.email, 200);
  if (email && !EMAIL_RE.test(email)) throw new Error(`"${email}" is not a valid email address`);
  return { ...base, name: str(b.name ?? base.name, 120), role: str(b.role ?? base.role, 120), email,
    pod: Boolean(b.pod ?? base.pod), dailySummary: Boolean(b.dailySummary ?? base.dailySummary) };
}
app.post('/api/team', (req, res) => {
  let m;
  try { m = cleanMember(req.body); } catch (e) { return bad(res, e.message); }
  if (!m.name) return bad(res, 'Name is required');
  const created = store.mutate(user(req), { type: 'team', action: 'created', summary: `Added team member ${m.name}` }, db => {
    const n = { id: store.nextId(db.team), ...m };
    db.team.push(n);
    return n;
  });
  res.status(201).json(created);
});
app.put('/api/team/:id', (req, res) => {
  const m = store.get().team.find(x => x.id === Number(req.params.id));
  if (!m) return bad(res, 'Member not found', 404);
  let next;
  try { next = cleanMember(req.body, m); } catch (e) { return bad(res, e.message); }
  store.mutate(user(req), { type: 'team', action: 'updated', summary: `Updated team member ${next.name}` }, () => Object.assign(m, next));
  res.json(m);
});
app.delete('/api/team/:id', (req, res) => {
  const id = Number(req.params.id);
  store.mutate(user(req), { type: 'team', action: 'deleted', summary: `Removed team member #${id}` }, db => {
    db.team = db.team.filter(x => x.id !== id);
  });
  res.json({ ok: true });
});

app.put('/api/settings', (req, res) => {
  const b = req.body;
  const time = v => (/^([01]\d|2[0-3]):[0-5]\d$/.test(v || '') ? v : undefined);
  store.mutate(user(req), { type: 'settings', action: 'updated', summary: 'Updated email settings' }, db => {
    if ('alertsEnabled' in b) db.settings.alertsEnabled = Boolean(b.alertsEnabled);
    if ('summaryEnabled' in b) db.settings.summaryEnabled = Boolean(b.summaryEnabled);
    if (time(b.summaryTime)) db.settings.summaryTime = b.summaryTime;
    if (time(b.alertTime)) db.settings.alertTime = b.alertTime;
    if (['daily', 'weekdays', 'mon-sat'].includes(b.summaryDays)) db.settings.summaryDays = b.summaryDays;
  });
  notify.schedule();
  res.json(notify.settings());
});

// Manual triggers (used by the "Send now" buttons and for testing SMTP).
app.post('/api/notify/summary', async (req, res, next) => {
  try { res.json(await notify.sendDailySummary({ manual: true })); } catch (e) { next(e); }
});
app.post('/api/notify/alerts', async (req, res, next) => {
  try { res.json(await notify.runDelayCheck({ reason: `Run manually by ${user(req)}` })); } catch (e) { next(e); }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    console.log(`MFI Project Tracker running on http://localhost:${port}`);
    if (!mailer.configured()) console.log('[mail] SMTP_HOST not set: emails will be saved to data/outbox instead of sent.');
    notify.schedule();
  });
}

module.exports = app;
