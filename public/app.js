// MFI Project Tracker — browser app (no build step).
(() => {
  'use strict';

  // ---------- state ----------
  let S = null;            // server state
  let loadedAt = '';       // when S was fetched (for edit-conflict checks)
  let tab = readLS('tab') || 'dashboard';
  const F = Object.assign({ q: '', brick: '', channel: '', status: '', spoc: '', late: false, hideDone: false }, readJSON('filters'));
  let momSel = null, momQ = '', momType = '';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const stCls = s => 'st-' + String(s || 'TBD').replace(/\s+/g, '');
  const fmt = iso => {
    if (!iso) return '';
    const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' });
  };
  const chVal = (ch, v) => (/Date$/.test(ch.field) ? fmt(v) : v);
  const changeHtml = ch => `${esc(ch.label)}: <s class="muted">${esc(chVal(ch, ch.from) || '—')}</s> → <b>${esc(chVal(ch, ch.to) || '—')}</b>`;
  const fmtTime = iso => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

  function readLS(k) { try { return localStorage.getItem('mfi.' + k); } catch { return null; } }
  function writeLS(k, v) { try { localStorage.setItem('mfi.' + k, v); } catch { /* storage unavailable */ } }
  function readJSON(k) { try { return JSON.parse(readLS(k) || '{}'); } catch { return {}; } }

  // ---------- API ----------
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-User': encodeURIComponent(readLS('user') || '') },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function refresh() {
    S = await api('GET', 'api/state');
    loadedAt = new Date().toISOString();
    renderWho();
    render();
  }

  function toast(msg, error = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (error ? ' error' : '');
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, error ? 6000 : 2800);
  }

  async function act(fn, okMsg) {
    try {
      await fn();
      if (okMsg) toast(okMsg);
      await refresh();
      return true;
    } catch (e) {
      toast(e.message, true);
      if (/updated this task/.test(e.message)) await refresh();
      return false;
    }
  }

  // ---------- header ----------
  function renderWho() {
    const sel = $('#whoami');
    const cur = readLS('user') || '';
    const names = S.team.map(m => m.name);
    sel.innerHTML = `<option value="">Select your name…</option>` +
      names.map(n => `<option ${n === cur ? 'selected' : ''}>${esc(n)}</option>`).join('');
    $('#brandSub').textContent = `${S.overview.title} · ${fmt(S.today)}`;
  }
  $('#whoami').addEventListener('change', e => { writeLS('user', e.target.value); toast(e.target.value ? `Updates will be recorded as ${e.target.value}` : 'Name cleared'); });

  function needUser() {
    if (readLS('user')) return true;
    toast('Pick your name in "You are" (top right) first, so the team knows who made the change.', true);
    $('#whoami').focus();
    return false;
  }

  // ---------- tabs ----------
  $('#tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    tab = b.dataset.tab;
    writeLS('tab', tab);
    render();
  });

  function render() {
    if (!S) return;
    $$('#tabs button').forEach(b => {
      b.setAttribute('aria-selected', b.dataset.tab === tab);
      const n = b.dataset.tab === 'tracker' ? S.summary.overdue.length : b.dataset.tab === 'mom' ? S.summary.overdueActions.length : 0;
      b.querySelector('.count')?.remove();
      if (n) b.insertAdjacentHTML('beforeend', `<span class="count" title="Delayed">${n}</span>`);
    });
    const v = $('#view');
    const scroll = window.scrollY;
    ({ dashboard, tracker, mom, datacuts, overview, team }[tab] || dashboard)(v);
    window.scrollTo(0, scroll);
  }

  // ---------- shared bits ----------
  const brickPill = b => `<span class="brick ${esc(b)}">${esc(b)}</span>`;
  const statusPill = s => `<span class="pill ${stCls(s)}">${esc(s)}</span>`;
  const lateBadge = t => t.overdue ? `<span class="badge-late">${t.daysLate}d late</span>` : t.dueToday ? '<span class="badge-today">Due today</span>' : '';
  const statusOptions = cur => S.meta.statuses.map(s => `<option ${s === cur ? 'selected' : ''}>${esc(s)}</option>`).join('');
  const spocNames = () => [...new Set(S.tasks.flatMap(t => String(t.spoc || '').split(/\s*\/\s*/)).filter(Boolean))].sort();

  function taskLine(t, extra = '') {
    return `<li class="clickable" data-edit-task="${t.id}">
      ${brickPill(t.brick)}
      <div class="grow"><div class="title">#${t.id} · ${esc(t.workstream)}</div><div class="small">${esc(t.task)}</div>
      <div class="small muted">${esc(t.spoc || 'No SPOC')}${t.dueDate ? ' · due ' + fmt(t.dueDate) : ''}</div></div>
      <div style="text-align:right">${statusPill(t.status)}<div style="margin-top:4px">${extra || lateBadge(t)}</div></div></li>`;
  }

  // ---------- Dashboard ----------
  function dashboard(v) {
    const sm = S.summary, c = sm.counts;
    const colors = { Completed: '#5CC27A', 'In Progress': '#E3D44A', Blocked: '#E26D5C', 'On Hold': '#F2A65A', 'Not Started': '#AFC0D0', TBD: '#D5DCE3' };
    const bar = ts => {
      const n = ts.length || 1;
      return `<div class="bar">${S.meta.statuses.slice().reverse().map(s => {
        const k = ts.filter(t => t.status === s).length;
        return k ? `<span style="width:${(k / n) * 100}%;background:${colors[s]}" title="${esc(s)}: ${k}"></span>` : '';
      }).join('')}</div>`;
    };
    const recent = (S._activity || []).slice(0, 12);
    v.innerHTML = `
      <div class="page-head"><div><h2>Today · ${fmt(S.today)}</h2><p>Live status of the MFI digital journeys tracker. Daily summary email goes out at ${esc(S.settings.summaryTime)} (${esc(S.timeZone)}).</p></div>
        <div class="row"><button class="btn" data-go="tracker">Open tracker</button><button class="btn primary" data-new-mom>+ Record MOM</button></div></div>
      <div class="kpis">
        <div class="kpi"><div class="v">${sm.total}</div><div class="l">Total tasks</div></div>
        <div class="kpi green"><div class="v">${c.Completed}<span class="small muted"> · ${sm.completion}%</span></div><div class="l">Completed</div></div>
        <div class="kpi amber"><div class="v">${c['In Progress']}</div><div class="l">In progress</div></div>
        <div class="kpi ${sm.overdue.length ? 'red' : ''}"><div class="v">${sm.overdue.length}</div><div class="l">Delayed</div></div>
        <div class="kpi ${c.Blocked ? 'red' : ''}"><div class="v">${c.Blocked}</div><div class="l">Blocked</div></div>
        <div class="kpi"><div class="v">${sm.dueToday.length + sm.dueSoon.length}</div><div class="l">Due in 3 days</div></div>
        <div class="kpi"><div class="v">${sm.openActions.length}</div><div class="l">Open MOM actions</div></div>
      </div>
      <div class="dash-grid">
        <div class="grid">
          <div class="card"><h3>Progress by brick</h3>
            ${['TOFU', 'MOFU', 'BOFU'].map(b => { const ts = S.tasks.filter(t => t.brick === b); const x = sm.byBrick.find(y => y.brick === b);
              return `<div class="brick-row">${brickPill(b)}${bar(ts)}<div class="small">${x.done}/${x.total} done${x.overdue ? ` · <span class="late">${x.overdue} late</span>` : ''}</div></div>`; }).join('')}
            <div class="brick-row"><b class="small">All</b>${bar(S.tasks)}<div class="small">${c.Completed}/${sm.total} done</div></div>
            <div class="legend">${S.meta.statuses.map(s => `<span><i style="background:${colors[s]}"></i>${esc(s)} ${c[s]}</span>`).join('')}</div>
          </div>
          <div class="card"><h3 class="${sm.overdue.length ? 'late' : ''}">Delayed (${sm.overdue.length})</h3>
            ${sm.overdue.length ? `<ul class="list">${sm.overdue.map(t => taskLine(t)).join('')}</ul>` : `<div class="empty">Nothing is past its due date.${sm.noDueDate ? ` ${sm.noDueDate} open tasks have no due date yet — add due dates so delays can be tracked.` : ''}</div>`}
          </div>
          ${sm.blocked.length ? `<div class="card"><h3 class="late">Blocked (${sm.blocked.length})</h3><ul class="list">${sm.blocked.map(t => taskLine(t)).join('')}</ul></div>` : ''}
          <div class="card"><h3>Due in the next 3 days (${sm.dueToday.length + sm.dueSoon.length})</h3>
            ${sm.dueToday.length + sm.dueSoon.length ? `<ul class="list">${[...sm.dueToday, ...sm.dueSoon].map(t => taskLine(t)).join('')}</ul>` : '<div class="empty">Nothing due soon.</div>'}
          </div>
        </div>
        <div class="grid">
          <div class="card"><h3>Updated today (${sm.updatedToday.length})</h3>
            ${sm.updatedToday.length ? `<ul class="list">${sm.updatedToday.map(({ task: t, activity: a }) => `<li class="clickable" data-edit-task="${t.id}"><div class="grow">
              <div class="title">#${t.id} · ${esc(t.workstream)}</div>
              <div class="small">${a.changes.length ? a.changes.map(ch => `${changeHtml(ch)}`).join('<br>') : esc(a.summary)}</div>
              <div class="small muted">by ${esc(a.user)}</div></div>${statusPill(t.status)}</li>`).join('')}</ul>` : '<div class="empty">No updates yet today.</div>'}
          </div>
          <div class="card"><h3 class="${sm.overdueActions.length ? 'late' : ''}">Overdue MOM action items (${sm.overdueActions.length})</h3>
            ${sm.overdueActions.length ? `<ul class="list">${sm.overdueActions.map(a => `<li class="clickable" data-open-mom="${a.meetingId}"><div class="grow"><div class="title">${esc(a.text)}</div>
              <div class="small muted">${esc(a.owner || 'No owner')} · from ${esc(a.meetingTitle)}</div></div><span class="badge-late">${a.daysLate}d late</span></li>`).join('')}</ul>` : '<div class="empty">No overdue action items.</div>'}
          </div>
          <div class="card"><h3>Recent activity</h3>
            ${recent.length ? `<ul class="list">${recent.map(a => `<li><div class="grow small"><b>${esc(a.user)}</b> ${esc(a.summary || a.action)}${a.changes && a.changes.length ? ': ' + a.changes.map(ch => esc(ch.label + ' → ' + (chVal(ch, ch.to) || '—'))).join(', ') : ''}</div><span class="small muted nowrap">${fmtTime(a.at)}</span></li>`).join('')}</ul>` : '<div class="empty">No activity yet.</div>'}
          </div>
        </div>
      </div>`;
    if (!S._activity) api('GET', 'api/activity?limit=50').then(a => { S._activity = a; if (tab === 'dashboard') render(); }).catch(() => {});
  }

  // ---------- Project Tracker ----------
  function filteredTasks() {
    const q = F.q.trim().toLowerCase();
    return S.tasks.filter(t =>
      (!F.brick || t.brick === F.brick) && (!F.channel || t.channel === F.channel) && (!F.status || t.status === F.status) &&
      (!F.spoc || String(t.spoc).split(/\s*\/\s*/).includes(F.spoc)) && (!F.late || t.overdue || t.status === 'Blocked') &&
      (!F.hideDone || t.status !== 'Completed') &&
      (!q || [t.id, t.workstream, t.task, t.spoc, t.outcome, t.ticket, t.remarks].join(' ').toLowerCase().includes(q)));
  }

  function tracker(v) {
    const sel = (key, label, opts) => `<select data-filter="${key}" aria-label="${label}"><option value="">${label}: all</option>${opts.map(o => `<option ${o === F[key] ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    const ts = filteredTasks();
    const groups = ['TOFU', 'MOFU', 'BOFU'].map(b => [b, ts.filter(t => t.brick === b)]).filter(([, l]) => l.length);
    v.innerHTML = `
      <div class="page-head"><div><h2>Project Tracker</h2><p>All workstreams, grouped by Growth Strategy brick. Change status straight from the table; click a row to edit dates, SPOC, ticket and remarks.</p></div>
        <button class="btn primary" data-new-task>+ Add task</button></div>
      <div class="filters">
        <input type="search" placeholder="Search tasks, SPOC, ticket…" value="${esc(F.q)}" data-filter="q" aria-label="Search">
        ${sel('brick', 'Brick', S.meta.bricks)}${sel('channel', 'Channel', S.meta.channels)}${sel('status', 'Status', S.meta.statuses)}${sel('spoc', 'SPOC', spocNames())}
        <label class="chk"><input type="checkbox" data-filter="late" ${F.late ? 'checked' : ''}> Delayed / blocked only</label>
        <label class="chk"><input type="checkbox" data-filter="hideDone" ${F.hideDone ? 'checked' : ''}> Hide completed</label>
        <span class="spacer"></span><span class="small muted">${ts.length} of ${S.tasks.length} tasks</span>
        ${Object.entries(F).some(([, x]) => x) ? '<button class="btn sm ghost" data-clear-filters>Clear filters</button>' : ''}
      </div>
      <div class="table-wrap"><table class="grid-table">
        <thead><tr><th>#</th><th>Channel</th><th>Workstream / task</th><th>Status</th><th>SPOC</th><th>Start</th><th>Due</th><th>Linked FY28 outcome</th><th>Ticket</th></tr></thead>
        <tbody>${groups.length ? groups.map(([b, list]) => `
          <tr class="group"><td colspan="9">${brickPill(b)} <span style="margin-left:6px">${list.length} task${list.length > 1 ? 's' : ''}</span></td></tr>
          ${list.map(t => `<tr class="item clickable ${t.overdue ? 'overdue' : ''}" data-edit-task="${t.id}">
            <td class="num">${t.id}</td>
            <td><span class="channel">${esc(t.channel)}</span></td>
            <td class="task-cell"><div class="ws">${esc(t.workstream)}</div><div>${esc(t.task)}</div>${t.remarks ? `<div class="remarks">💬 ${esc(t.remarks)}</div>` : ''}</td>
            <td><select class="status ${stCls(t.status)}" data-status-task="${t.id}" aria-label="Status of task ${t.id}">${statusOptions(t.status)}</select></td>
            <td>${esc(t.spoc) || '<span class="muted">—</span>'}</td>
            <td class="nowrap">${fmt(t.startDate) || '<span class="muted">—</span>'}</td>
            <td class="nowrap">${t.dueDate ? `<span class="${t.overdue ? 'late' : ''}">${fmt(t.dueDate)}</span>` : '<span class="muted">—</span>'}<div>${lateBadge(t)}</div></td>
            <td class="outcome">${esc(t.outcome)}</td>
            <td class="small">${esc(t.ticket) || '<span class="muted">—</span>'}</td>
          </tr>`).join('')}`).join('') : '<tr><td colspan="9" class="empty" style="text-align:center;padding:30px">No tasks match these filters.</td></tr>'}
        </tbody></table></div>`;
  }

  document.addEventListener('input', e => {
    const k = e.target.dataset.filter;
    if (!k) return;
    F[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    writeLS('filters', JSON.stringify(F));
    if (k === 'q') {
      clearTimeout(tracker.t);
      tracker.t = setTimeout(() => { render(); const i = $('[data-filter="q"]'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 200);
    } else render();
  });

  document.addEventListener('change', async e => {
    const id = e.target.dataset.statusTask;
    if (!id) return;
    if (!needUser()) { render(); return; }
    await act(() => api('PUT', `api/tasks/${id}`, { status: e.target.value, _loadedAt: loadedAt }), `Task #${id} → ${e.target.value}`);
  });

  // ---------- modal ----------
  function modal(title, bodyHtml, { wide = false, footer = '' } = {}) {
    const root = $('#modalRoot');
    root.innerHTML = `<div class="modal-backdrop"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header><h3 style="margin:0">${esc(title)}</h3><button class="close" data-close aria-label="Close">×</button></header>
      <div class="body">${bodyHtml}</div>${footer ? `<footer>${footer}</footer>` : ''}</div></div>`;
    const m = $('.modal', root);
    $('input, textarea, select', m)?.focus();
    return m;
  }
  const closeModal = () => { $('#modalRoot').innerHTML = ''; };
  const modalOpen = () => Boolean($('#modalRoot').innerHTML);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && modalOpen()) closeModal(); });
  $('#modalRoot').addEventListener('mousedown', e => { if (e.target.classList.contains('modal-backdrop')) closeModal(); });

  const opt = (list, cur) => list.map(o => `<option ${o === cur ? 'selected' : ''}>${esc(o)}</option>`).join('');
  const peopleList = () => `<datalist id="people">${[...new Set([...S.team.map(m => m.name), ...spocNames()])].map(n => `<option value="${esc(n)}">`).join('')}</datalist>`;

  function taskForm(t) {
    const isNew = !t.id;
    const m = modal(isNew ? 'Add task' : `Task #${t.id}`, `
      <form id="taskForm" class="form-grid">
        <label class="field"><span>Brick</span><select name="brick">${opt(S.meta.bricks, t.brick)}</select></label>
        <label class="field"><span>Channel</span><select name="channel">${opt(S.meta.channels, t.channel)}</select></label>
        <label class="field full"><span>Workstream</span><input type="text" name="workstream" value="${esc(t.workstream)}" list="workstreams">
          <datalist id="workstreams">${[...new Set(S.tasks.map(x => x.workstream))].map(w => `<option value="${esc(w)}">`).join('')}</datalist></label>
        <label class="field full"><span>Task / step *</span><textarea name="task" rows="2" required>${esc(t.task)}</textarea></label>
        <label class="field"><span>Status</span><select name="status">${opt(S.meta.statuses, t.status)}</select></label>
        <label class="field"><span>SPOC (use “ / ” for more than one)</span><input type="text" name="spoc" value="${esc(t.spoc)}" list="people">${peopleList()}</label>
        <label class="field"><span>Start date</span><input type="date" name="startDate" value="${esc(t.startDate)}"></label>
        <label class="field"><span>Due date (used for delay alerts)</span><input type="date" name="dueDate" value="${esc(t.dueDate)}"></label>
        <label class="field full"><span>Linked FY28 outcome</span><input type="text" name="outcome" value="${esc(t.outcome)}"></label>
        <label class="field"><span>Ticket (Jira / ADO / request ID)</span><input type="text" name="ticket" value="${esc(t.ticket)}"></label>
        <div class="field"><span>Last updated</span><div class="small muted" style="padding-top:8px">${t.updatedAt ? `${fmtTime(t.updatedAt)} by ${esc(t.updatedBy || '—')}` : '—'}</div></div>
        <label class="field full"><span>Remarks / latest update</span><textarea name="remarks" rows="3" placeholder="What changed, blockers, next step…">${esc(t.remarks)}</textarea></label>
      </form>
      ${!isNew ? historyHtml(t.id) : ''}`,
    { footer: `${!isNew ? '<button class="btn danger" data-delete-task>Delete</button><span class="spacer"></span>' : ''}<button class="btn" data-close>Cancel</button><button class="btn primary" data-save-task>${isNew ? 'Add task' : 'Save changes'}</button>` });
    m.addEventListener('click', async e => {
      if (e.target.closest('[data-save-task]')) {
        if (!needUser()) return;
        const f = $('#taskForm', m);
        if (!f.reportValidity()) return;
        const body = Object.fromEntries(new FormData(f));
        const ok = await act(() => isNew ? api('POST', 'api/tasks', body) : api('PUT', `api/tasks/${t.id}`, { ...body, _loadedAt: loadedAt }), isNew ? 'Task added' : `Task #${t.id} saved`);
        if (ok) closeModal();
      }
      if (e.target.closest('[data-delete-task]')) {
        if (!needUser() || !confirm(`Delete task #${t.id}? This cannot be undone (download the .xlsx first if you want a copy).`)) return;
        if (await act(() => api('DELETE', `api/tasks/${t.id}`), `Task #${t.id} deleted`)) closeModal();
      }
    });
    if (!isNew) api('GET', 'api/activity?limit=1000').then(a => {
      const h = $('#taskHistory', m);
      const rows = a.filter(x => x.type === 'task' && x.id === t.id).slice(0, 15);
      if (h) h.innerHTML = rows.length ? rows.map(x => `<li><div class="grow small">${x.changes && x.changes.length ? x.changes.map(ch => `${changeHtml(ch)}`).join('<br>') : esc(x.summary)}</div><span class="small muted nowrap">${esc(x.user)} · ${fmtTime(x.at)}</span></li>`).join('') : '<li class="empty">No changes recorded yet.</li>';
    }).catch(() => {});
  }
  const historyHtml = () => `<h3 style="margin-top:8px">Change history</h3><ul class="list" id="taskHistory"><li class="empty">Loading…</li></ul>`;

  // ---------- MOM ----------
  function mom(v) {
    const q = momQ.toLowerCase();
    const list = [...S.meetings].sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.id - a.id)
      .filter(m => (!momType || m.type === momType) && (!q || [m.title, m.attendees, m.agenda, m.notes, m.decisions, ...(m.actionItems || []).map(a => a.text + ' ' + a.owner)].join(' ').toLowerCase().includes(q)));
    if (!momSel || !S.meetings.some(m => m.id === momSel)) momSel = list[0]?.id || null;
    const m = S.meetings.find(x => x.id === momSel);
    v.innerHTML = `
      <div class="page-head"><div><h2>MOM &amp; Meeting Notes</h2><p>Minutes of every important discussion: attendees, notes, decisions and action items. Overdue action items trigger alerts too, and any action item can be pushed to the tracker.</p></div>
        <button class="btn primary" data-new-mom>+ Record MOM</button></div>
      <div class="mom-layout">
        <div class="mom-list">
          <div class="search"><input type="search" placeholder="Search notes…" value="${esc(momQ)}" id="momQ" aria-label="Search meetings">
            <select id="momType" aria-label="Meeting type"><option value="">All types</option>${opt(S.meta.meetingTypes, momType)}</select></div>
          ${list.length ? list.map(x => {
            const open = (x.actionItems || []).filter(a => a.status !== 'Done').length;
            const late = (x.actionItems || []).filter(a => a.overdue).length;
            return `<button class="mom-item ${x.id === momSel ? 'active' : ''}" data-open-mom="${x.id}"><div class="t">${esc(x.title)}</div>
              <div class="m">${fmt(x.date)} · ${esc(x.type)}${open ? ` · ${open} open action${open > 1 ? 's' : ''}` : ''}${late ? ` · <span class="late">${late} late</span>` : ''}</div></button>`;
          }).join('') : `<div class="empty" style="padding:16px">${S.meetings.length ? 'No meetings match.' : 'No meetings recorded yet. Click “+ Record MOM” after your next discussion.'}</div>`}
        </div>
        <div class="card mom-detail">${m ? momDetail(m) : '<div class="empty">Select a meeting, or record a new one.</div>'}</div>
      </div>`;
    const qi = $('#momQ');
    qi.addEventListener('input', () => { momQ = qi.value; clearTimeout(mom.t); mom.t = setTimeout(() => { render(); const i = $('#momQ'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 200); });
    $('#momType').addEventListener('change', e => { momType = e.target.value; render(); });
  }

  function momDetail(m) {
    const sec = (t, body) => body ? `<div class="mom-section"><h4>${t}</h4><div class="body">${esc(body)}</div></div>` : '';
    const acts = m.actionItems || [];
    return `<div class="row"><h2>${esc(m.title)}</h2><span class="spacer"></span>
        <button class="btn sm" data-edit-mom="${m.id}">Edit</button><button class="btn sm danger" data-delete-mom="${m.id}">Delete</button></div>
      <div class="mom-meta"><span>📅 ${fmt(m.date)}${m.time ? ' · ' + esc(m.time) : ''}</span><span>🏷 ${esc(m.type)}</span>
        <span>✍️ Recorded by ${esc(m.createdBy || '—')}</span>${m.nextMeeting ? `<span>➡️ Next meeting ${fmt(m.nextMeeting)}</span>` : ''}</div>
      ${sec('Attendees', m.attendees)}${sec('Agenda', m.agenda)}${sec('Discussion notes', m.notes)}${sec('Decisions', m.decisions)}
      <div class="mom-section"><h4>Action items (${acts.length})</h4>
        ${acts.length ? `<table class="actions-table"><thead><tr><th style="width:36px">Done</th><th>Action</th><th>Owner</th><th>Due</th><th>Tracker</th></tr></thead><tbody>
          ${acts.map(a => `<tr>
            <td><input type="checkbox" data-toggle-action="${m.id}:${a.id}" ${a.status === 'Done' ? 'checked' : ''} aria-label="Mark done"></td>
            <td style="${a.status === 'Done' ? 'text-decoration:line-through;color:#6B7B8C' : ''}">${esc(a.text)}</td>
            <td>${esc(a.owner) || '<span class="muted">—</span>'}</td>
            <td class="nowrap">${a.dueDate ? `<span class="${a.overdue ? 'late' : ''}">${fmt(a.dueDate)}</span>` : '<span class="muted">—</span>'} ${a.overdue ? `<span class="badge-late">${a.daysLate}d</span>` : ''}</td>
            <td>${a.taskId && S.tasks.some(t => t.id === a.taskId) ? `<button class="btn sm ghost" data-edit-task="${a.taskId}">Task #${a.taskId}</button>` : `<button class="btn sm" data-to-task="${m.id}:${a.id}">+ Add to tracker</button>`}</td>
          </tr>`).join('')}</tbody></table>` : '<div class="empty">No action items.</div>'}
      </div>`;
  }

  function momForm(m) {
    const isNew = !m.id;
    const me = readLS('user') || '';
    const acts = (m.actionItems || []).length ? m.actionItems : [{ text: '', owner: '', dueDate: '', status: 'Open' }];
    const aiRow = a => `<div class="ai-row" data-ai>
      <input type="hidden" name="aid" value="${esc(a.id || '')}"><input type="hidden" name="taskId" value="${esc(a.taskId || '')}">
      <input type="text" name="text" placeholder="Action item" value="${esc(a.text)}" aria-label="Action item">
      <input type="text" name="owner" placeholder="Owner" value="${esc(a.owner)}" list="people" aria-label="Owner">
      <input type="date" name="dueDate" value="${esc(a.dueDate)}" aria-label="Due date">
      <select name="status" aria-label="Status"><option ${a.status !== 'Done' ? 'selected' : ''}>Open</option><option ${a.status === 'Done' ? 'selected' : ''}>Done</option></select>
      <button type="button" class="btn sm ghost" data-remove-ai aria-label="Remove">✕</button></div>`;
    const md = modal(isNew ? 'Record minutes of meeting' : 'Edit MOM', `
      <form id="momForm" class="form-grid">
        <label class="field full"><span>Meeting / topic *</span><input type="text" name="title" required value="${esc(m.title)}" placeholder="e.g. Lite BRE integration review with COE"></label>
        <label class="field"><span>Date</span><input type="date" name="date" value="${esc(m.date || S.today)}"></label>
        <label class="field"><span>Time</span><input type="text" name="time" value="${esc(m.time)}" placeholder="e.g. 11:00–11:45"></label>
        <label class="field"><span>Type</span><select name="type">${opt(S.meta.meetingTypes, m.type || 'POD stand-up')}</select></label>
        <label class="field"><span>Next meeting (optional)</span><input type="date" name="nextMeeting" value="${esc(m.nextMeeting)}"></label>
        <label class="field full"><span>Attendees</span><input type="text" name="attendees" value="${esc(m.attendees || (isNew ? me : ''))}" placeholder="Names, comma separated"></label>
        <label class="field full"><span>Agenda</span><textarea name="agenda" rows="2">${esc(m.agenda)}</textarea></label>
        <label class="field full"><span>Discussion notes</span><textarea name="notes" rows="6" placeholder="Key points discussed…">${esc(m.notes)}</textarea></label>
        <label class="field full"><span>Decisions</span><textarea name="decisions" rows="3" placeholder="One decision per line">${esc(m.decisions)}</textarea></label>
        <div class="field full"><span>Action items</span><div id="aiList">${acts.map(aiRow).join('')}</div>
          <div><button type="button" class="btn sm" data-add-ai>+ Add action item</button></div>${peopleList()}</div>
      </form>`, { wide: true, footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" data-save-mom>${isNew ? 'Save MOM' : 'Save changes'}</button>` });
    md.addEventListener('click', async e => {
      if (e.target.closest('[data-add-ai]')) { $('#aiList', md).insertAdjacentHTML('beforeend', aiRow({ text: '', owner: '', dueDate: '', status: 'Open' })); $$('[data-ai]', md).pop().querySelector('[name=text]').focus(); }
      if (e.target.closest('[data-remove-ai]')) e.target.closest('[data-ai]').remove();
      if (e.target.closest('[data-save-mom]')) {
        if (!needUser()) return;
        const f = $('#momForm', md);
        if (!f.reportValidity()) return;
        const body = Object.fromEntries([...new FormData(f)].filter(([k]) => !['aid', 'taskId', 'text', 'owner', 'dueDate', 'status'].includes(k)));
        body.actionItems = $$('[data-ai]', md).map(r => ({
          id: r.querySelector('[name=aid]').value, taskId: r.querySelector('[name=taskId]').value, text: r.querySelector('[name=text]').value,
          owner: r.querySelector('[name=owner]').value, dueDate: r.querySelector('[name=dueDate]').value, status: r.querySelector('[name=status]').value,
        })).filter(a => a.text.trim());
        let saved;
        const ok = await act(async () => { saved = isNew ? await api('POST', 'api/meetings', body) : await api('PUT', `api/meetings/${m.id}`, body); }, 'MOM saved');
        if (ok) { momSel = saved.id; tab = 'mom'; writeLS('tab', tab); closeModal(); render(); }
      }
    });
  }

  async function toggleAction(mid, aid, done) {
    const m = S.meetings.find(x => x.id === mid);
    const body = { ...m, actionItems: m.actionItems.map(a => a.id === aid ? { ...a, status: done ? 'Done' : 'Open' } : a) };
    await act(() => api('PUT', `api/meetings/${mid}`, body), done ? 'Action item done' : 'Action item reopened');
  }

  // ---------- Data cuts ----------
  function datacuts(v) {
    v.innerHTML = `
      <div class="page-head"><div><h2>Data Cuts</h2><p>Data prep steps and the list of data cuts needed. Click a row to update its status, owner and due date.</p></div>
        <button class="btn primary" data-new-cut>+ Add data cut</button></div>
      <div class="card" style="margin-bottom:16px"><h3>Data prep steps</h3><div class="kv">${S.dataPrepSteps.map(s => `<div class="k">${esc(s.label)}</div><div>${esc(s.text)}</div>`).join('')}</div></div>
      <div class="table-wrap"><table class="grid-table">
        <thead><tr><th>Data cut</th><th>Who to include</th><th>Fields to pull</th><th>Output</th><th>Time period</th><th>Status</th><th>Owner</th><th>Due</th><th>Remarks</th></tr></thead>
        <tbody>${S.dataCuts.map(d => `<tr class="item clickable ${d.overdue ? 'overdue' : ''}" data-edit-cut="${d.id}">
          <td class="ws">${esc(d.cut)}</td><td class="small">${esc(d.who)}</td><td class="small">${esc(d.fields)}</td><td class="small">${esc(d.output)}</td>
          <td class="small nowrap">${esc(d.period)}</td><td>${statusPill(d.status)}</td><td class="small">${esc(d.owner) || '<span class="muted">—</span>'}</td>
          <td class="nowrap small">${d.dueDate ? `<span class="${d.overdue ? 'late' : ''}">${fmt(d.dueDate)}</span>` : '<span class="muted">—</span>'}</td>
          <td class="small">${esc(d.remarks)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function cutForm(d) {
    const isNew = !d.id;
    const fld = (k, l, ta) => `<label class="field ${ta ? 'full' : ''}"><span>${l}</span>${ta ? `<textarea name="${k}" rows="2">${esc(d[k])}</textarea>` : `<input type="text" name="${k}" value="${esc(d[k])}">`}</label>`;
    const m = modal(isNew ? 'Add data cut' : d.cut, `<form id="cutForm" class="form-grid">
        <label class="field full"><span>Data cut *</span><input type="text" name="cut" required value="${esc(d.cut)}"></label>
        ${fld('who', 'Who to include', true)}${fld('fields', 'Fields to pull', true)}${fld('output', 'Output', true)}${fld('period', 'Time period')}
        <label class="field"><span>Status</span><select name="status">${opt(S.meta.statuses, d.status || 'TBD')}</select></label>
        <label class="field"><span>Owner</span><input type="text" name="owner" value="${esc(d.owner)}" list="people">${peopleList()}</label>
        <label class="field"><span>Due date</span><input type="date" name="dueDate" value="${esc(d.dueDate)}"></label>
        ${fld('remarks', 'Remarks', true)}</form>`,
    { footer: `${!isNew ? '<button class="btn danger" data-del>Delete</button><span class="spacer"></span>' : ''}<button class="btn" data-close>Cancel</button><button class="btn primary" data-save>Save</button>` });
    m.addEventListener('click', async e => {
      if (e.target.closest('[data-save]')) {
        if (!needUser()) return;
        const f = $('#cutForm', m);
        if (!f.reportValidity()) return;
        const body = Object.fromEntries(new FormData(f));
        if (await act(() => isNew ? api('POST', 'api/datacuts', body) : api('PUT', `api/datacuts/${d.id}`, body), 'Data cut saved')) closeModal();
      }
      if (e.target.closest('[data-del]') && needUser() && confirm(`Delete "${d.cut}"?`)) {
        if (await act(() => api('DELETE', `api/datacuts/${d.id}`), 'Deleted')) closeModal();
      }
    });
  }

  // ---------- Overview & Scope ----------
  function overview(v) {
    const o = S.overview;
    const sections = (title, list) => `<div class="card" style="margin-top:16px"><h3>${title}</h3>${list.map(s => `
      <div class="section-head">${esc(s.heading)}</div>${s.intro ? `<div class="intro">${esc(s.intro)}</div>` : ''}
      ${s.items.length ? `<div class="kv">${s.items.map(i => `<div class="k">${esc(i.label)}</div><div>${esc(i.text)}</div>`).join('')}</div>` : ''}`).join('')}</div>`;
    v.innerHTML = `
      <div class="page-head"><div><h2>${esc(o.title)}</h2><p>${esc(o.subtitle)}</p></div></div>
      <div class="ov-grid">
        <div class="h first">BRICK</div>${o.channels.map(c => `<div class="h">${esc(c.toUpperCase())}</div>`).join('')}
        ${o.bricks.map(b => `<div class="b" style="background:var(--${b.brick.toLowerCase()})">${esc(b.brick)}<small>${esc(b.label)}</small></div>
          ${b.cells.map(c => `<div><ul>${c.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div>`).join('')}`).join('')}
      </div>
      <div class="card" style="margin-top:16px"><h3>${esc(o.targetsTitle)}</h3>
        <div class="kv" style="grid-template-columns:160px 1fr 1fr 1fr">${o.targets.map(r => r.map((c, i) => `<div class="${i === 0 ? 'k' : ''}">${esc(c)}</div>`).join('')).join('')}</div></div>
      ${sections('Research brief', S.research)}
      ${sections('Scope', S.scope)}`;
  }

  // ---------- Team & Alerts ----------
  function team(v) {
    const st = S.settings;
    const withEmail = S.team.filter(m => m.email);
    v.innerHTML = `
      <div class="page-head"><div><h2>Team &amp; Alerts</h2><p>Add each team member's email. <b>POD members</b> get every delay alert; SPOCs get alerts for their own tasks; members ticked for the <b>daily summary</b> get the ${esc(st.summaryTime)} email.</p></div>
        <button class="btn primary" data-new-member>+ Add person</button></div>
      <div class="team-grid">
        <div class="table-wrap" style="max-height:none"><table class="grid-table" style="min-width:640px">
          <thead><tr><th>Name</th><th>Role</th><th>Email</th><th title="Receives all delay alerts">POD member</th><th title="Receives the daily summary">Daily summary</th><th></th></tr></thead>
          <tbody>${S.team.map(m => `<tr class="item">
            <td class="ws">${esc(m.name)}</td><td class="small">${esc(m.role) || '<span class="muted">—</span>'}</td>
            <td class="small">${m.email ? esc(m.email) : '<span class="muted">no email — will not get emails</span>'}</td>
            <td><input type="checkbox" data-member-flag="${m.id}:pod" ${m.pod ? 'checked' : ''} aria-label="POD member"></td>
            <td><input type="checkbox" data-member-flag="${m.id}:dailySummary" ${m.dailySummary ? 'checked' : ''} aria-label="Daily summary"></td>
            <td><button class="btn sm" data-edit-member="${m.id}">Edit</button></td></tr>`).join('')}</tbody></table></div>
        <div class="grid">
          <div class="card"><h3>Automated emails</h3>
            ${st.mailConfigured ? '<div class="notice ok">Email server connected. Emails are being sent.</div>'
              : '<div class="notice"><b>Email server not set up yet.</b> Emails are saved on the server (data/outbox) instead of sent. Add the SMTP settings from the README to start sending.</div>'}
            ${withEmail.length ? '' : '<div class="notice">Nobody has an email address yet, so no one will receive alerts. Edit team members to add emails.</div>'}
            <form id="settingsForm">
              <label class="chk" style="margin-bottom:10px"><input type="checkbox" name="summaryEnabled" ${st.summaryEnabled ? 'checked' : ''}> Daily summary email</label>
              <div class="row" style="margin-bottom:12px"><label class="field" style="margin:0"><span>Send at</span><input type="time" name="summaryTime" value="${esc(st.summaryTime)}"></label>
                <label class="field" style="margin:0"><span>On</span><select name="summaryDays">${[['daily', 'Every day'], ['mon-sat', 'Mon–Sat'], ['weekdays', 'Mon–Fri']].map(([k, l]) => `<option value="${k}" ${st.summaryDays === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
              <label class="chk" style="margin-bottom:10px"><input type="checkbox" name="alertsEnabled" ${st.alertsEnabled ? 'checked' : ''}> Delay alerts</label>
              <div class="small muted" style="margin-bottom:10px">Checked every morning at the time below, and about a minute after anyone saves a change. Each delay is emailed once, then stays on the daily summary until it is resolved.</div>
              <label class="field"><span>Morning delay check at</span><input type="time" name="alertTime" value="${esc(st.alertTime)}"></label>
              <div class="small muted" style="margin-bottom:12px">Times are ${esc(S.timeZone)}.</div>
              <button type="button" class="btn primary" data-save-settings>Save settings</button>
            </form>
            <hr style="border:0;border-top:1px solid var(--line);margin:16px 0">
            <div class="row"><button class="btn" data-send-summary>Send today's summary now</button><button class="btn" data-run-alerts>Run delay check now</button></div>
            <div class="small muted" style="margin-top:10px">
              Last summary: ${st.lastSummary ? `${fmtTime(st.lastSummary.at)} to ${st.lastSummary.to.length} people` : 'not sent yet'}<br>
              Last alert: ${st.lastAlert ? `${fmtTime(st.lastAlert.at)} · ${st.lastAlert.count} item(s)` : 'none yet'}</div>
          </div>
        </div>
      </div>`;
  }

  function memberForm(m) {
    const isNew = !m.id;
    const md = modal(isNew ? 'Add person' : `Edit ${m.name}`, `<form id="memberForm" class="form-grid">
      <label class="field"><span>Name * (as written in the SPOC column)</span><input type="text" name="name" required value="${esc(m.name)}"></label>
      <label class="field"><span>Role</span><input type="text" name="role" value="${esc(m.role)}" placeholder="e.g. Product Manager, Designer"></label>
      <label class="field full"><span>Email</span><input type="email" name="email" value="${esc(m.email)}" placeholder="name@company.com"></label>
      <label class="chk"><input type="checkbox" name="pod" ${m.pod ? 'checked' : ''}> POD member (gets all delay alerts)</label>
      <label class="chk"><input type="checkbox" name="dailySummary" ${m.dailySummary ? 'checked' : ''}> Gets the daily summary</label></form>`,
    { footer: `${!isNew ? '<button class="btn danger" data-del>Remove</button><span class="spacer"></span>' : ''}<button class="btn" data-close>Cancel</button><button class="btn primary" data-save>Save</button>` });
    md.addEventListener('click', async e => {
      if (e.target.closest('[data-save]')) {
        if (!needUser()) return;
        const f = $('#memberForm', md);
        if (!f.reportValidity()) return;
        const body = { name: f.name.value, role: f.role.value, email: f.email.value, pod: f.pod.checked, dailySummary: f.dailySummary.checked };
        if (await act(() => isNew ? api('POST', 'api/team', body) : api('PUT', `api/team/${m.id}`, body), 'Saved')) closeModal();
      }
      if (e.target.closest('[data-del]') && needUser() && confirm(`Remove ${m.name}? Their tasks keep the SPOC name.`)) {
        if (await act(() => api('DELETE', `api/team/${m.id}`), 'Removed')) closeModal();
      }
    });
  }

  // ---------- global click handling ----------
  document.addEventListener('click', async e => {
    const el = e.target.closest('[data-close],[data-go],[data-new-task],[data-edit-task],[data-new-mom],[data-open-mom],[data-edit-mom],[data-delete-mom],[data-to-task],[data-new-cut],[data-edit-cut],[data-new-member],[data-edit-member],[data-save-settings],[data-send-summary],[data-run-alerts],[data-clear-filters]');
    if (!el || e.target.matches('select, select *, input')) return;
    const d = el.dataset;
    if ('close' in d) return closeModal();
    if (d.go) { tab = d.go; writeLS('tab', tab); return render(); }
    if ('newTask' in d) return taskForm({ brick: F.brick || 'TOFU', channel: F.channel || 'App', workstream: '', task: '', status: 'Not Started', spoc: readLS('user') || '', outcome: '', ticket: '', startDate: S.today, dueDate: '', remarks: '' });
    if (d.editTask) { const t = S.tasks.find(x => x.id === Number(d.editTask)); if (t) taskForm(t); return; }
    if ('newMom' in d) return momForm({});
    if (d.openMom) { momSel = Number(d.openMom); tab = 'mom'; writeLS('tab', tab); return render(); }
    if (d.editMom) return momForm(S.meetings.find(x => x.id === Number(d.editMom)));
    if (d.deleteMom) {
      const m = S.meetings.find(x => x.id === Number(d.deleteMom));
      if (needUser() && confirm(`Delete the MOM "${m.title}"?`)) await act(() => api('DELETE', `api/meetings/${m.id}`), 'MOM deleted');
      return;
    }
    if (d.toTask) {
      if (!needUser()) return;
      const [mid, aid] = d.toTask.split(':').map(Number);
      return act(() => api('POST', `api/meetings/${mid}/actions/${aid}/to-task`, {}), 'Added to the Project Tracker (MOFU · Loan Journey — edit it to change brick/channel)');
    }
    if ('newCut' in d) return cutForm({ status: 'TBD' });
    if (d.editCut) return cutForm(S.dataCuts.find(x => x.id === Number(d.editCut)));
    if ('newMember' in d) return memberForm({ pod: true, dailySummary: true });
    if (d.editMember) return memberForm(S.team.find(x => x.id === Number(d.editMember)));
    if ('clearFilters' in d) { Object.assign(F, { q: '', brick: '', channel: '', status: '', spoc: '', late: false, hideDone: false }); writeLS('filters', JSON.stringify(F)); return render(); }
    if ('saveSettings' in d) {
      if (!needUser()) return;
      const f = $('#settingsForm');
      return act(() => api('PUT', 'api/settings', { summaryEnabled: f.summaryEnabled.checked, alertsEnabled: f.alertsEnabled.checked, summaryTime: f.summaryTime.value, alertTime: f.alertTime.value, summaryDays: f.summaryDays.value }), 'Email settings saved');
    }
    if ('sendSummary' in d || 'runAlerts' in d) {
      if (!needUser()) return;
      el.disabled = true;
      try {
        const r = await api('POST', 'sendSummary' in d ? 'api/notify/summary' : 'api/notify/alerts');
        toast(r.skipped ? r.reason : r.preview ? `SMTP not set up: email saved on the server for ${r.to.length} recipient(s)` : `Email sent to ${r.to.length} recipient(s)`, Boolean(r.skipped && /recipient/i.test(r.reason)));
        await refresh();
      } catch (err) { toast(err.message, true); } finally { el.disabled = false; }
    }
  });

  document.addEventListener('change', async e => {
    if (e.target.dataset.toggleAction) {
      if (!needUser()) { e.target.checked = !e.target.checked; return; }
      const [mid, aid] = e.target.dataset.toggleAction.split(':').map(Number);
      return toggleAction(mid, aid, e.target.checked);
    }
    if (e.target.dataset.memberFlag) {
      if (!needUser()) { e.target.checked = !e.target.checked; return; }
      const [id, flag] = e.target.dataset.memberFlag.split(':');
      return act(() => api('PUT', `api/team/${id}`, { [flag]: e.target.checked }), 'Saved');
    }
  });

  // ---------- live updates: poll for changes from teammates ----------
  setInterval(async () => {
    if (document.hidden || modalOpen() || !S) return;
    try {
      const { version } = await api('GET', 'api/version');
      if (version !== S.version) { const active = document.activeElement; if (active && active.matches('input[type=search]')) return; await refresh(); }
    } catch { /* offline; try again next tick */ }
  }, 20000);

  refresh().catch(e => { $('#view').innerHTML = `<div class="loading">Could not load the tracker: ${esc(e.message)}</div>`; });
})();
