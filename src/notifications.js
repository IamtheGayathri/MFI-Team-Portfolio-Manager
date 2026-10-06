// Automated emails:
//  • Delay alerts  — when a tracker task or MOM action item passes its due date
//    without being completed, or a task is marked Blocked. Each delay is emailed
//    once (it then stays on the daily summary until resolved).
//  • Daily summary — today's tracker status at 6 PM (team time zone), with the
//    Excel tracker attached.
const cron = require('node-cron');
const store = require('./store');
const mailer = require('./mailer');
const { buildWorkbook } = require('./excel');
const { buildSummary, decorateTask, actionItems, spocMembers, findMember, emails } = require('./tracker');
const { TZ, todayISO, fmt } = require('./dates');

const DEFAULTS = { alertsEnabled: true, summaryEnabled: true, summaryTime: '18:00', alertTime: '09:30', summaryDays: 'daily' };
const APP_URL = () => (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

function settings() {
  return { ...DEFAULTS, ...store.get().settings };
}

// ---------- HTML helpers (inline styles: email clients ignore <style>) ----------
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const STATUS_BG = { 'TBD': '#F2F2F2', 'Not Started': '#E7ECF1', 'In Progress': '#F9FFC1', 'Blocked': '#F8C9C4', 'On Hold': '#FFE0B2', 'Completed': '#AEF4A7' };
const BRICK_BG = { TOFU: '#2E86AB', MOFU: '#E07A5F', BOFU: '#81B29A' };
const pill = (text, bg, color = '#243746') =>
  `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:${bg};color:${color};font-size:11px;font-weight:600;white-space:nowrap">${esc(text)}</span>`;
const th = t => `<th style="text-align:left;padding:8px;background:#17324D;color:#fff;font-size:12px;font-weight:600">${t}</th>`;
const td = (t, extra = '') => `<td style="padding:8px;border-bottom:1px solid #E3E8EE;font-size:13px;vertical-align:top;${extra}">${t}</td>`;

function taskTable(tasks, { showLate = false, showRemarks = true } = {}) {
  if (!tasks.length) return '<p style="color:#6B7B8C;font-size:13px;margin:4px 0 16px">None.</p>';
  return `<table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;margin:4px 0 20px">
    <tr>${th('#')}${th('Task')}${th('SPOC')}${th('Status')}${th('Due')}${showLate ? th('Late') : ''}</tr>
    ${tasks.map(t => `<tr>
      ${td(`${t.id}<br>${pill(t.brick, BRICK_BG[t.brick] || '#999', '#fff')}`)}
      ${td(`<b style="color:#17324D">${esc(t.workstream)}</b><br>${esc(t.task)}${showRemarks && t.remarks ? `<br><i style="color:#6B7B8C">Update: ${esc(t.remarks)}</i>` : ''}`)}
      ${td(esc(t.spoc || '—'))}
      ${td(pill(t.status, STATUS_BG[t.status] || '#eee'))}
      ${td(esc(fmt(t.dueDate) || '—'), 'white-space:nowrap')}
      ${showLate ? td(`<b style="color:#C0392B">${t.daysLate}d</b>`) : ''}
    </tr>`).join('')}
  </table>`;
}

function actionTable(items) {
  if (!items.length) return '<p style="color:#6B7B8C;font-size:13px;margin:4px 0 16px">None.</p>';
  return `<table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;margin:4px 0 20px">
    <tr>${th('Action item')}${th('Owner')}${th('From meeting')}${th('Due')}${th('Late')}</tr>
    ${items.map(a => `<tr>${td(esc(a.text))}${td(esc(a.owner || '—'))}${td(`${esc(a.meetingTitle)}<br><span style="color:#6B7B8C">${esc(fmt(a.meetingDate))}</span>`)}
      ${td(esc(fmt(a.dueDate)), 'white-space:nowrap')}${td(`<b style="color:#C0392B">${a.daysLate}d</b>`)}</tr>`).join('')}
  </table>`;
}

function layout(title, subtitle, body) {
  return `<!doctype html><html><body style="margin:0;background:#F3F6F8;font-family:Arial,Helvetica,sans-serif;color:#243746">
  <table width="100%" cellspacing="0" cellpadding="0" style="background:#F3F6F8"><tr><td align="center" style="padding:24px 12px">
  <table width="760" cellspacing="0" cellpadding="0" style="max-width:760px;width:100%;background:#fff;border-radius:8px;overflow:hidden">
    <tr><td style="background:#17324D;padding:20px 24px;color:#fff">
      <div style="font-size:20px;font-weight:700">${esc(title)}</div>
      <div style="font-size:13px;font-style:italic;opacity:.85;margin-top:4px">${esc(subtitle)}</div>
    </td></tr>
    <tr><td style="padding:20px 24px">${body}
      <p style="margin:24px 0 0"><a href="${APP_URL()}" style="background:#2E86AB;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px">Open the tracker</a></p>
    </td></tr>
    <tr><td style="padding:12px 24px;background:#F3F6F8;color:#6B7B8C;font-size:11px">Automated email from the MFI Project Tracker. Change who receives it on the Team &amp; Alerts tab.</td></tr>
  </table></td></tr></table></body></html>`;
}

const chVal = (ch, v) => (/Date$/.test(ch.field) ? fmt(v) : v);
const h2 = (t, color = '#17324D') => `<h3 style="margin:8px 0 6px;font-size:15px;color:${color}">${t}</h3>`;

// ---------- Recipients ----------
function podEmails(db) {
  return emails(db.team.filter(m => m.pod));
}
function summaryEmails(db) {
  return emails(db.team.filter(m => m.dailySummary));
}

// ---------- Delay alerts ----------
function alreadySent(db, key) {
  return db.alertLog.some(a => a.key === key);
}

// Finds delays that have not been emailed yet and sends one alert email for them.
async function runDelayCheck({ reason = 'scheduled' } = {}) {
  const db = store.get();
  const s = settings();
  if (!s.alertsEnabled) return { skipped: true, reason: 'Alerts are switched off' };
  const today = todayISO();
  const newTasks = db.tasks.map(t => decorateTask(t, today))
    .filter(t => t.overdue && !alreadySent(db, `task:${t.id}:${t.dueDate}`));
  const blocked = db.tasks.filter(t => t.status === 'Blocked' && !alreadySent(db, `blocked:${t.id}:${t.blockedSince || ''}`));
  const newActions = actionItems(db, today).filter(a => a.overdue && !alreadySent(db, `action:${a.meetingId}:${a.id}:${a.dueDate}`));
  if (!newTasks.length && !blocked.length && !newActions.length) return { skipped: true, reason: 'Nothing newly delayed' };

  const to = [...podEmails(db)];
  for (const t of [...newTasks, ...blocked]) to.push(...emails(spocMembers(db.team, t.spoc)));
  for (const a of newActions) { const m = findMember(db.team, a.owner || ''); if (m) to.push(...emails([m])); }

  const n = newTasks.length + blocked.length + newActions.length;
  let body = `<p style="font-size:14px;margin:0 0 16px">${n} item${n > 1 ? 's need' : ' needs'} attention. Please update the status, add a remark or agree a new due date in the tracker.</p>`;
  if (newTasks.length) body += h2(`⏰ Past due date (${newTasks.length})`, '#C0392B') + taskTable(newTasks, { showLate: true });
  if (blocked.length) body += h2(`⛔ Marked Blocked (${blocked.length})`, '#C0392B') + taskTable(blocked);
  if (newActions.length) body += h2(`📝 Overdue MOM action items (${newActions.length})`, '#C0392B') + actionTable(newActions);

  const subject = `⚠ MFI Tracker alert: ${n} delayed item${n > 1 ? 's' : ''} · ${fmt(today)}`;
  const result = await mailer.send({ to, subject, html: layout('Delay alert · MFI Project Tracker', `${fmt(today)} · ${reason}`, body) });
  if (!result.skipped) {
    const at = new Date().toISOString();
    db.alertLog.push(
      ...newTasks.map(t => ({ key: `task:${t.id}:${t.dueDate}`, at })),
      ...blocked.map(t => ({ key: `blocked:${t.id}:${t.blockedSince || ''}`, at })),
      ...newActions.map(a => ({ key: `action:${a.meetingId}:${a.id}:${a.dueDate}`, at })),
    );
    db.alertLog = db.alertLog.slice(-5000);
    db.settings.lastAlert = { at, count: n, to: result.to };
    store.save();
  }
  return { ...result, count: n };
}

// ---------- Daily summary ----------
function summaryHtml(db, sm) {
  const c = sm.counts;
  const tile = (label, value, color) => `<td style="padding:6px"><div style="background:#F3F6F8;border-radius:6px;padding:12px;text-align:center">
    <div style="font-size:24px;font-weight:700;color:${color}">${value}</div><div style="font-size:11px;color:#6B7B8C;text-transform:uppercase;letter-spacing:.04em">${label}</div></div></td>`;
  let body = `<table width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 16px"><tr>
    ${tile('Total tasks', sm.total, '#17324D')}${tile('Completed', `${c.Completed} · ${sm.completion}%`, '#2E7D32')}
    ${tile('In progress', c['In Progress'], '#8A6D00')}${tile('Delayed', sm.overdue.length, sm.overdue.length ? '#C0392B' : '#17324D')}
    ${tile('Blocked', c.Blocked, c.Blocked ? '#C0392B' : '#17324D')}</tr></table>`;
  body += `<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:0 0 20px"><tr>${th('Brick')}${th('Tasks')}${th('Completed')}${th('Delayed')}</tr>
    ${sm.byBrick.map(b => `<tr>${td(pill(b.brick, BRICK_BG[b.brick], '#fff'))}${td(b.total)}${td(b.done)}${td(b.overdue ? `<b style="color:#C0392B">${b.overdue}</b>` : 0)}</tr>`).join('')}</table>`;

  body += h2(`✅ Updated today (${sm.updatedToday.length})`);
  if (sm.updatedToday.length) {
    body += `<table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;margin:4px 0 20px"><tr>${th('#')}${th('Task')}${th('What changed')}${th('By')}</tr>
      ${sm.updatedToday.map(({ task: t, activity: a }) => `<tr>${td(t.id)}${td(`<b style="color:#17324D">${esc(t.workstream)}</b><br>${esc(t.task)}`)}
        ${td(a.changes.length ? a.changes.map(ch => `${esc(ch.label)}: <s style="color:#999">${esc(chVal(ch, ch.from) || '—')}</s> → <b>${esc(chVal(ch, ch.to) || '—')}</b>`).join('<br>') : esc(a.summary || 'Updated'))}
        ${td(esc(a.user))}</tr>`).join('')}</table>`;
  } else body += '<p style="color:#6B7B8C;font-size:13px;margin:4px 0 16px">No tracker updates today.</p>';

  body += h2(`⏰ Delayed (${sm.overdue.length})`, sm.overdue.length ? '#C0392B' : '#17324D') + taskTable(sm.overdue, { showLate: true });
  if (sm.blocked.length) body += h2(`⛔ Blocked (${sm.blocked.length})`, '#C0392B') + taskTable(sm.blocked);
  body += h2(`📅 Due in the next 3 days (${sm.dueToday.length + sm.dueSoon.length})`) + taskTable([...sm.dueToday, ...sm.dueSoon]);
  if (sm.overdueActions.length) body += h2(`📝 Overdue MOM action items (${sm.overdueActions.length})`, '#C0392B') + actionTable(sm.overdueActions);
  if (sm.meetingsToday.length) {
    body += h2(`🗒 Meetings recorded today (${sm.meetingsToday.length})`);
    body += sm.meetingsToday.map(m => `<div style="border-left:3px solid #2E86AB;padding:6px 12px;margin:0 0 12px;font-size:13px">
      <b>${esc(m.title)}</b> <span style="color:#6B7B8C">· ${esc(m.type || '')}</span>
      ${m.decisions ? `<div style="margin-top:4px"><b>Decisions:</b><br>${esc(m.decisions).replace(/\n/g, '<br>')}</div>` : ''}
      ${(m.actionItems || []).length ? `<div style="margin-top:4px"><b>Actions:</b><br>${m.actionItems.map(a => `• ${esc(a.text)}${a.owner ? ' — ' + esc(a.owner) : ''}${a.dueDate ? ' · ' + esc(fmt(a.dueDate)) : ''}`).join('<br>')}</div>` : ''}
    </div>`).join('');
  }
  if (sm.noDueDate) body += `<p style="font-size:12px;color:#6B7B8C">${sm.noDueDate} open tasks have no due date yet, so they cannot be checked for delays.</p>`;
  body += '<p style="font-size:12px;color:#6B7B8C">The full tracker is attached as an Excel file.</p>';
  return body;
}

async function sendDailySummary({ manual = false } = {}) {
  const db = store.get();
  const s = settings();
  if (!manual && !s.summaryEnabled) return { skipped: true, reason: 'Daily summary is switched off' };
  const sm = buildSummary(db);
  const xlsx = await buildWorkbook(db, sm.today);
  const subject = `MFI Tracker daily summary · ${fmt(sm.today)} · ${sm.counts.Completed}/${sm.total} done${sm.overdue.length ? ` · ${sm.overdue.length} delayed` : ''}`;
  const result = await mailer.send({
    to: summaryEmails(db),
    subject,
    html: layout(`Daily summary · ${fmt(sm.today)}`, "Today's tracker with the latest status", summaryHtml(db, sm)),
    attachments: [{ filename: `MFI_Project_Tracker_${sm.today}.xlsx`, content: Buffer.from(xlsx) }],
  });
  if (!result.skipped) {
    db.settings.lastSummary = { at: new Date().toISOString(), to: result.to };
    store.save();
  }
  return result;
}

// ---------- Scheduler ----------
let jobs = [];

function cronAt(hhmm, days) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return `${m || 0} ${h || 0} * * ${days === 'weekdays' ? '1-5' : days === 'mon-sat' ? '1-6' : '*'}`;
}

const safely = (name, fn) => async () => {
  try {
    const r = await fn();
    console.log(`[${name}]`, r.skipped ? `skipped: ${r.reason}` : 'done');
  } catch (e) {
    console.error(`[${name}] failed:`, e.message);
  }
};

function schedule() {
  jobs.forEach(j => j.stop());
  const s = settings();
  jobs = [
    cron.schedule(cronAt(s.summaryTime, s.summaryDays), safely('daily-summary', () => sendDailySummary()), { timezone: TZ }),
    cron.schedule(cronAt(s.alertTime, 'daily'), safely('delay-check', () => runDelayCheck({ reason: 'Morning delay check' })), { timezone: TZ }),
  ];
  console.log(`[scheduler] summary "${cronAt(s.summaryTime, s.summaryDays)}", delay check "${cronAt(s.alertTime, 'daily')}" (${TZ})`);
}

// After someone saves a change, check again (debounced) so a newly Blocked task
// or a due date set in the past is alerted straight away, not next morning.
let pending;
function checkSoon() {
  clearTimeout(pending);
  pending = setTimeout(safely('delay-check', () => runDelayCheck({ reason: 'Triggered by a tracker update' })), 60 * 1000);
  pending.unref?.();
}

module.exports = { schedule, runDelayCheck, sendDailySummary, checkSoon, settings, DEFAULTS, summaryHtml, layout };
