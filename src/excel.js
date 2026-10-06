// Builds the downloadable .xlsx with the same look and column layout as the
// reference workbook (navy banner, brick colours, status colours, frozen header,
// filters, status drop-down), plus the MOM tabs.
const ExcelJS = require('exceljs');
const { STATUSES, decorateTask, actionItems } = require('./tracker');
const { todayISO, fmt } = require('./dates');

const NAVY = 'FF17324D';
const INK = 'FF243746';
const GRID = 'FFCCCCCC';
const BRICK_FILL = { TOFU: 'FF2E86AB', MOFU: 'FFE07A5F', BOFU: 'FF81B29A' };
const STATUS_FILL = {
  'TBD': 'FFF2F2F2', 'Not Started': 'FFE7ECF1', 'In Progress': 'FFF9FFC1',
  'Blocked': 'FFF8C9C4', 'On Hold': 'FFFFE0B2', 'Completed': 'FFAEF4A7',
  'Open': 'FFF9FFC1', 'Done': 'FFAEF4A7',
};
const OVERDUE_FILL = 'FFFDE2E1';

const fill = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = { style: 'thin', color: { argb: GRID } };
const box = { top: thin, left: thin, bottom: thin, right: thin };
const font = (o = {}) => ({ name: 'Arial', size: 10, color: { argb: INK }, ...o });

function style(cell, { f, bg, h = 'left', v = 'top', border = true } = {}) {
  cell.font = font(f);
  if (bg) cell.fill = fill(bg);
  cell.alignment = { horizontal: h, vertical: v, wrapText: true };
  if (border) cell.border = box;
}

// Navy title + italic subtitle across the sheet, as on the reference tabs.
function banner(ws, from, to, title, subtitle, h1 = 32, h2 = 28) {
  ws.mergeCells(`${from}2:${to}2`);
  ws.mergeCells(`${from}3:${to}3`);
  const t = ws.getCell(`${from}2`);
  t.value = title;
  style(t, { f: { size: 18, bold: true, color: { argb: 'FFFFFFFF' } }, bg: NAVY, v: 'middle', border: false });
  const s = ws.getCell(`${from}3`);
  s.value = subtitle;
  style(s, { f: { italic: true, color: { argb: 'FFFFFFFF' } }, bg: NAVY, v: 'middle', border: false });
  ws.getRow(2).height = h1;
  ws.getRow(3).height = h2;
}

function header(ws, rowNum, startCol, labels, height = 26) {
  const row = ws.getRow(rowNum);
  labels.forEach((l, i) => {
    const c = row.getCell(startCol + i);
    c.value = l;
    style(c, { f: { bold: true, color: { argb: 'FFFFFFFF' } }, bg: NAVY, h: 'center', v: 'middle' });
  });
  row.height = height;
}

function widths(ws, list) {
  list.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
}

function dateVal(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

// Row height estimate so wrapped text is visible when opened (Excel doesn't auto-fit merged/wrapped rows).
function fitHeight(texts, min = 48) {
  const lines = Math.max(...texts.map(([t, w]) => String(t || '').split('\n')
    .reduce((n, part) => n + Math.max(1, Math.ceil(part.length / Math.max(1, w * 1.1))), 0)));
  return Math.max(min, lines * 13 + 8);
}

function overviewSheet(wb, db) {
  const o = db.overview;
  const ws = wb.addWorksheet('1 · Overview', { views: [{ showGridLines: false }] });
  widths(ws, [3, 22, 38, 38, 38, 3]);
  banner(ws, 'B', 'E', o.title, o.subtitle, 36, 36);
  header(ws, 5, 2, ['BRICK'], 22);
  o.channels.forEach((ch, i) => {
    const c = ws.getRow(5).getCell(3 + i);
    c.value = ch.toUpperCase();
    style(c, { f: { bold: true, color: { argb: NAVY } }, bg: 'FFD9E8F5', h: 'center', v: 'middle', border: false });
  });
  o.bricks.forEach((b, i) => {
    const row = ws.getRow(6 + i);
    row.height = 90;
    const bc = row.getCell(2);
    bc.value = `${b.brick}\n${b.label}`;
    style(bc, { f: { size: 12, bold: true, color: { argb: 'FFFFFFFF' } }, bg: BRICK_FILL[b.brick], h: 'center', v: 'middle', border: false });
    b.cells.forEach((lines, j) => {
      const c = row.getCell(3 + j);
      c.value = lines.map(l => `• ${l}`).join('\n');
      style(c);
    });
  });
  ws.mergeCells('B10:E10');
  const tt = ws.getCell('B10');
  tt.value = o.targetsTitle;
  style(tt, { f: { bold: true, color: { argb: 'FFFFFFFF' } }, bg: NAVY, v: 'middle', border: false });
  ws.getRow(10).height = 22;
  o.targets.forEach((r, i) => {
    const row = ws.getRow(11 + i);
    row.height = 22;
    r.forEach((v, j) => {
      const c = row.getCell(2 + j);
      c.value = v;
      style(c, { f: j === 0 ? { bold: true, color: { argb: NAVY } } : {}, v: 'middle' });
    });
  });
}

function trackerSheet(wb, db, today) {
  const ws = wb.addWorksheet('2 · Project Tracker', { views: [{ state: 'frozen', ySplit: 5, showGridLines: false }] });
  // B–J match the reference tracker exactly; K–O add the dates needed for delay tracking.
  widths(ws, [3, 6, 11, 10, 24, 52, 13, 20, 32, 22, 12, 12, 10, 34, 18, 3]);
  banner(ws, 'B', 'O', db.overview.title,
    `All workstreams in one view, grouped by Growth Strategy brick (TOFU · MOFU · BOFU). Exported ${fmt(today)}. Rows shaded red are past their due date.`);
  header(ws, 5, 2, ['#', 'Brick', 'Channel', 'Workstream', 'Task / step', 'Status', 'SPOC', 'Linked FY28 outcome', 'Ticket',
    'Start date', 'Due date', 'Days late', 'Remarks / latest update', 'Last updated']);
  const order = { TOFU: 0, MOFU: 1, BOFU: 2 };
  const tasks = db.tasks.map(t => decorateTask(t, today))
    .sort((a, b) => (order[a.brick] ?? 9) - (order[b.brick] ?? 9) || a.id - b.id);
  tasks.forEach((t, i) => {
    const r = ws.getRow(6 + i);
    const vals = [t.id, t.brick, t.channel, t.workstream, t.task, t.status, t.spoc, t.outcome, t.ticket || null,
      dateVal(t.startDate), dateVal(t.dueDate), t.overdue ? t.daysLate : null, t.remarks || null,
      t.updatedAt ? `${fmt(t.updatedAt.slice(0, 10))}${t.updatedBy ? ' · ' + t.updatedBy : ''}` : null];
    vals.forEach((v, j) => { r.getCell(2 + j).value = v; });
    style(r.getCell(2), { h: 'center', v: 'middle' });
    style(r.getCell(3), { f: { bold: true, color: { argb: 'FFFFFFFF' } }, bg: BRICK_FILL[t.brick], h: 'center', v: 'middle' });
    style(r.getCell(4), { f: { bold: true, color: { argb: NAVY } }, bg: 'FFD9E8F5', h: 'center', v: 'middle' });
    style(r.getCell(5), { f: { bold: true, color: { argb: NAVY } } });
    style(r.getCell(6), { bg: t.overdue ? OVERDUE_FILL : undefined });
    style(r.getCell(7), { bg: STATUS_FILL[t.status], h: 'center', v: 'middle' });
    style(r.getCell(8));
    style(r.getCell(9), { f: { size: 9, italic: true, color: { argb: 'FF666666' } } });
    style(r.getCell(10), { f: { size: 9, color: { argb: 'FF0066CC' } } });
    for (const col of [11, 12]) {
      style(r.getCell(col), { h: 'center', v: 'middle' });
      r.getCell(col).numFmt = 'dd-mmm-yy';
    }
    if (t.overdue) r.getCell(12).font = font({ bold: true, color: { argb: 'FFC0392B' } });
    style(r.getCell(13), { f: t.overdue ? { bold: true, color: { argb: 'FFC0392B' } } : {}, h: 'center', v: 'middle' });
    style(r.getCell(14), { f: { size: 9 } });
    style(r.getCell(15), { f: { size: 9, color: { argb: 'FF666666' } } });
    r.height = fitHeight([[t.task, 52], [t.outcome, 34], [t.remarks, 36]]);
    r.getCell(7).dataValidation = { type: 'list', allowBlank: false, formulae: [`"${STATUSES.join(',')}"`] };
  });
  ws.autoFilter = { from: { row: 5, column: 2 }, to: { row: 5 + Math.max(tasks.length, 1), column: 15 } };
}

function momSheet(wb, db) {
  const ws = wb.addWorksheet('3 · MOM & Meeting Notes', { views: [{ state: 'frozen', ySplit: 5, showGridLines: false }] });
  widths(ws, [3, 6, 12, 30, 16, 24, 34, 50, 40, 46, 18, 3]);
  banner(ws, 'B', 'K', 'MINUTES OF MEETING · MFI POD',
    'Every important discussion in one place: who attended, what was discussed, what was decided and who owns the next step. Action items are tracked on tab 4.');
  header(ws, 5, 2, ['#', 'Date', 'Meeting / topic', 'Type', 'Attendees', 'Agenda', 'Discussion notes', 'Decisions', 'Action items (owner · due)', 'Recorded by']);
  const meetings = [...db.meetings].sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.id - a.id);
  meetings.forEach((m, i) => {
    const r = ws.getRow(6 + i);
    const acts = (m.actionItems || []).map((a, k) =>
      `${k + 1}. ${a.text}${a.owner ? ' — ' + a.owner : ''}${a.dueDate ? ' · ' + fmt(a.dueDate) : ''}${a.status === 'Done' ? ' ✓' : ''}`).join('\n');
    const vals = [m.id, dateVal(m.date), m.title + (m.time ? `\n${m.time}` : ''), m.type, m.attendees, m.agenda, m.notes, m.decisions, acts, m.createdBy];
    vals.forEach((v, j) => { r.getCell(2 + j).value = v || null; });
    style(r.getCell(2), { h: 'center', v: 'middle' });
    style(r.getCell(3), { h: 'center', v: 'top' });
    r.getCell(3).numFmt = 'dd-mmm-yy';
    style(r.getCell(4), { f: { bold: true, color: { argb: NAVY } } });
    style(r.getCell(5), { bg: 'FFD9E8F5', f: { bold: true, color: { argb: NAVY } }, h: 'center' });
    for (let c = 6; c <= 11; c++) style(r.getCell(c), { f: c === 11 ? { size: 9, color: { argb: 'FF666666' } } : { size: 9 } });
    r.height = Math.min(400, fitHeight([[m.notes, 50], [m.decisions, 40], [acts, 46], [m.agenda, 34], [m.attendees, 24]], 60));
  });
  if (!meetings.length) {
    ws.mergeCells('B6:K6');
    const c = ws.getCell('B6');
    c.value = 'No meetings recorded yet.';
    style(c, { f: { italic: true, color: { argb: 'FF666666' } }, h: 'center', v: 'middle' });
  }
  ws.autoFilter = { from: { row: 5, column: 2 }, to: { row: 5 + Math.max(meetings.length, 1), column: 11 } };
}

function actionSheet(wb, db, today) {
  const ws = wb.addWorksheet('4 · MOM Action Items', { views: [{ state: 'frozen', ySplit: 5, showGridLines: false }] });
  widths(ws, [3, 6, 12, 30, 52, 20, 12, 11, 10, 14, 3]);
  banner(ws, 'B', 'J', 'MOM ACTION ITEMS', 'Follow-ups agreed in meetings. Past-due open items are flagged red and included in the delay alerts.');
  header(ws, 5, 2, ['#', 'Meeting date', 'Meeting', 'Action item', 'Owner', 'Due date', 'Status', 'Days late', 'Tracker task #']);
  const items = actionItems(db, today).sort((a, b) => (b.meetingDate || '').localeCompare(a.meetingDate || ''));
  items.forEach((a, i) => {
    const r = ws.getRow(6 + i);
    [i + 1, dateVal(a.meetingDate), a.meetingTitle, a.text, a.owner, dateVal(a.dueDate), a.status || 'Open',
      a.overdue ? a.daysLate : null, a.taskId || null].forEach((v, j) => { r.getCell(2 + j).value = v ?? null; });
    style(r.getCell(2), { h: 'center', v: 'middle' });
    style(r.getCell(3), { h: 'center', v: 'middle' }); r.getCell(3).numFmt = 'dd-mmm-yy';
    style(r.getCell(4), { f: { bold: true, color: { argb: NAVY } } });
    style(r.getCell(5), { bg: a.overdue ? OVERDUE_FILL : undefined });
    style(r.getCell(6));
    style(r.getCell(7), { h: 'center', v: 'middle', f: a.overdue ? { bold: true, color: { argb: 'FFC0392B' } } : {} }); r.getCell(7).numFmt = 'dd-mmm-yy';
    style(r.getCell(8), { bg: STATUS_FILL[a.status || 'Open'], h: 'center', v: 'middle' });
    r.getCell(8).dataValidation = { type: 'list', allowBlank: false, formulae: ['"Open,Done"'] };
    style(r.getCell(9), { h: 'center', v: 'middle', f: a.overdue ? { bold: true, color: { argb: 'FFC0392B' } } : {} });
    style(r.getCell(10), { h: 'center', v: 'middle' });
    r.height = fitHeight([[a.text, 52], [a.meetingTitle, 30]], 32);
  });
  ws.autoFilter = { from: { row: 5, column: 2 }, to: { row: 5 + Math.max(items.length, 1), column: 10 } };
}

// Research Brief / Scope layout: label in A:B, text in C:H, two rows per item.
function briefSheet(wb, name, sections) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1, showGridLines: false }] });
  ws.getColumn(1).width = 17;
  for (let c = 2; c <= 8; c++) ws.getColumn(c).width = c === 2 ? 9 : 16;
  let r = 1;
  sections.forEach((s, si) => {
    if (si > 0) r++;
    ws.mergeCells(`A${r}:H${r}`);
    const h = ws.getCell(`A${r}`);
    h.value = s.heading;
    style(h, { f: { bold: true, color: { argb: 'FFFFFFFF' } }, bg: NAVY, v: 'middle', border: false });
    ws.getRow(r).height = 23;
    r++;
    if (s.intro) {
      ws.mergeCells(`A${r}:H${r + 1}`);
      const c = ws.getCell(`A${r}`);
      c.value = s.intro;
      style(c, { f: { size: 11, bold: true, color: { argb: NAVY } }, v: 'middle', border: false });
      ws.getRow(r).height = 22; ws.getRow(r + 1).height = 22;
      r += 2;
    }
    s.items.forEach((it, i) => {
      ws.mergeCells(`A${r}:B${r + 1}`);
      ws.mergeCells(`C${r}:H${r + 1}`);
      const a = ws.getCell(`A${r}`);
      a.value = it.label;
      style(a, { f: { size: 9, bold: true, color: { argb: NAVY } }, bg: i === 0 && si < 2 ? 'FFDCE8F2' : 'FFF3F6F8', v: 'middle' });
      const c = ws.getCell(`C${r}`);
      c.value = it.text;
      style(c, { f: { size: 9 }, v: 'middle' });
      const h2 = Math.max(22, Math.ceil(it.text.length / 95) * 13);
      ws.getRow(r).height = h2; ws.getRow(r + 1).height = h2;
      r += 2;
    });
  });
}

function dataCutsSheet(wb, db, today) {
  const ws = wb.addWorksheet('Data Cuts required', { views: [{ state: 'frozen', ySplit: 20, xSplit: 2, showGridLines: false }] });
  widths(ws, [18.4, 29, 34, 42, 34, 20, 18, 12, 39]);
  ws.mergeCells('A1:I1');
  const h = ws.getCell('A1');
  h.value = 'DATA PREP STEPS';
  style(h, { f: { bold: true, color: { argb: 'FFFFFFFF' } }, bg: NAVY, v: 'middle', border: false });
  db.dataPrepSteps.forEach((s, i) => {
    const r = 2 + i * 2;
    ws.mergeCells(`A${r}:B${r + 1}`);
    ws.mergeCells(`C${r}:I${r + 1}`);
    ws.getCell(`A${r}`).value = s.label;
    style(ws.getCell(`A${r}`), { f: { bold: true, color: { argb: NAVY } }, bg: 'FFDCE8F2', v: 'middle' });
    ws.getCell(`C${r}`).value = s.text;
    style(ws.getCell(`C${r}`), { f: { size: 9 }, v: 'middle' });
  });
  ws.mergeCells('A19:I19');
  const l = ws.getCell('A19');
  l.value = 'DATA CUT LIST';
  style(l, { f: { bold: true, color: { argb: 'FFFFFFFF' } }, bg: NAVY, v: 'middle', border: false });
  header(ws, 20, 1, ['Data cut', 'Who to include', 'Fields to pull', 'Output', 'Time period', 'Status', 'Owner', 'Due date', 'Remarks'], 22);
  ws.getRow(20).eachCell(c => { c.font = font({ size: 9, bold: true, color: { argb: 'FFFFFFFF' } }); });
  db.dataCuts.forEach((d, i) => {
    const r = ws.getRow(21 + i);
    const late = d.dueDate && d.status !== 'Completed' && d.dueDate < today;
    [d.cut, d.who, d.fields, d.output, d.period, d.status, d.owner, dateVal(d.dueDate), d.remarks]
      .forEach((v, j) => { r.getCell(1 + j).value = v || null; });
    for (let c = 1; c <= 9; c++) style(r.getCell(c), { f: { size: 9 }, v: 'middle' });
    r.getCell(6).fill = fill(d.status === 'TBD' ? 'FFFFF1CC' : STATUS_FILL[d.status] || 'FFFFF1CC');
    r.getCell(6).dataValidation = { type: 'list', allowBlank: false, formulae: [`"${STATUSES.join(',')}"`] };
    r.getCell(8).numFmt = 'dd-mmm-yy';
    if (late) r.getCell(8).font = font({ size: 9, bold: true, color: { argb: 'FFC0392B' } });
  });
}

function teamSheet(wb, db) {
  const ws = wb.addWorksheet('Team & SPOCs', { views: [{ state: 'frozen', ySplit: 5, showGridLines: false }] });
  widths(ws, [3, 6, 26, 26, 34, 12, 16, 3]);
  banner(ws, 'B', 'G', 'TEAM & SPOC DIRECTORY', 'POD members receive delay alerts; members ticked for the daily summary get the 6 PM email.');
  header(ws, 5, 2, ['#', 'Name', 'Role', 'Email', 'POD member', 'Daily 6 PM summary']);
  db.team.forEach((m, i) => {
    const r = ws.getRow(6 + i);
    [i + 1, m.name, m.role, m.email, m.pod ? 'Yes' : 'No', m.dailySummary ? 'Yes' : 'No'].forEach((v, j) => {
      r.getCell(2 + j).value = v || null;
      style(r.getCell(2 + j), { h: j === 0 || j >= 4 ? 'center' : 'left', v: 'middle' });
    });
    r.height = 20;
  });
}

// Print/PDF: landscape A4, all columns on one page width.
function printSetup(wb) {
  wb.worksheets.forEach(ws => {
    ws.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } };
  });
}

async function buildWorkbook(db, today = todayISO()) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MFI Project Tracker';
  wb.created = new Date();
  overviewSheet(wb, db);
  trackerSheet(wb, db, today);
  momSheet(wb, db);
  actionSheet(wb, db, today);
  briefSheet(wb, 'Research Brief', db.research);
  briefSheet(wb, 'Scope', db.scope);
  dataCutsSheet(wb, db, today);
  teamSheet(wb, db);
  printSetup(wb);
  return wb.xlsx.writeBuffer();
}

module.exports = { buildWorkbook };
