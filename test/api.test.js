// End-to-end: real server on a temp data dir, SMTP unset so emails land in data/outbox.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfi-'));
process.env.DATA_DIR = dir;
delete process.env.SMTP_HOST;
delete process.env.TEAM_PASSCODE;
process.env.SEED_FILE = path.join(__dirname, '..', 'seed', 'seed.example.json');
const app = require('../server');
const ExcelJS = require('exceljs');

let base, server;
test.before(async () => {
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const call = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-User': 'PM' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.arrayBuffer() };
};
const outbox = () => (fs.existsSync(path.join(dir, 'outbox')) ? fs.readdirSync(path.join(dir, 'outbox')).filter(f => f.endsWith('.html')) : []);

test('seeded tracker loads', async () => {
  const { body } = await call('GET', '/api/state');
  assert.strictEqual(body.tasks.length, 3);
  assert.strictEqual(body.dataCuts.length, 1);
  assert.ok(body.team.some(m => m.name === 'PM'));
});

test('task update is logged and an overdue task triggers one alert email', async () => {
  const st = (await call('GET', '/api/state')).body;
  const g = st.team.find(m => m.name === 'PM');
  assert.strictEqual((await call('PUT', `/api/team/${g.id}`, { email: 'pm@example.com', pod: true, dailySummary: true })).status, 200);
  const r = await call('PUT', '/api/tasks/1', { status: 'Blocked', dueDate: '2020-01-01', remarks: 'Waiting on data' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.updatedBy, 'PM');
  const a1 = (await call('POST', '/api/notify/alerts')).body;
  assert.strictEqual(a1.count, 2); // overdue + blocked
  assert.deepStrictEqual(a1.to, ['pm@example.com']);
  const a2 = (await call('POST', '/api/notify/alerts')).body;
  assert.ok(a2.skipped, 'same delay is not emailed twice');
  assert.strictEqual(outbox().length, 1);
});

test('rejects invalid input', async () => {
  assert.strictEqual((await call('POST', '/api/tasks', { task: '' })).status, 400);
  assert.strictEqual((await call('PUT', '/api/team/1', { email: 'not-an-email' })).status, 400);
  const r = await call('PUT', '/api/tasks/2', { status: 'Nonsense' });
  assert.strictEqual(r.body.status, 'TBD');
});

test('MOM with action items, push to tracker', async () => {
  const m = (await call('POST', '/api/meetings', { title: 'Lite BRE review', date: '2026-10-06', attendees: 'PM, Saswat', notes: 'Discussed rules', decisions: 'Use COE v2',
    actionItems: [{ text: 'Share BRE rule sheet', owner: 'Saswat', dueDate: '2026-10-09' }, { text: '' }] })).body;
  assert.strictEqual(m.actionItems.length, 1);
  assert.strictEqual(m.actionItems[0].id, 1);
  const t = await call('POST', `/api/meetings/${m.id}/actions/1/to-task`, {});
  assert.strictEqual(t.status, 201);
  assert.strictEqual(t.body.spoc, 'Saswat');
  assert.strictEqual((await call('POST', `/api/meetings/${m.id}/actions/1/to-task`, {})).status, 409);
});

test('daily summary email is built with the xlsx attached', async () => {
  const r = (await call('POST', '/api/notify/summary')).body;
  assert.ok(r.preview);
  const html = fs.readFileSync(r.preview, 'utf8');
  assert.match(html, /Daily summary/);
  assert.match(html, /Updated today/);
  assert.match(html, /Lite BRE review/);
  assert.ok(fs.readdirSync(path.join(dir, 'outbox')).some(f => f.endsWith('.xlsx')));
});

test('xlsx export has the reference layout plus MOM tabs', async () => {
  const r = await call('GET', '/api/export.xlsx');
  assert.strictEqual(r.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(r.body));
  assert.deepStrictEqual(wb.worksheets.map(w => w.name),
    ['1 · Overview', '2 · Project Tracker', '3 · MOM & Meeting Notes', '4 · MOM Action Items', 'Research Brief', 'Scope', 'Data Cuts required', 'Team & SPOCs']);
  const pt = wb.getWorksheet('2 · Project Tracker');
  assert.deepStrictEqual(pt.getRow(5).values.slice(2, 11), ['#', 'Brick', 'Channel', 'Workstream', 'Task / step', 'Status', 'SPOC', 'Linked FY28 outcome', 'Ticket']);
  assert.strictEqual(pt.getCell('C6').fill.fgColor.argb, 'FF2E86AB');
  assert.strictEqual(pt.views[0].ySplit, 5);
  const mom = wb.getWorksheet('3 · MOM & Meeting Notes');
  assert.strictEqual(mom.getCell('D6').value, 'Lite BRE review');
});
