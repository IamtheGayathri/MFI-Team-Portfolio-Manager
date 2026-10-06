const test = require('node:test');
const assert = require('node:assert');
const { delayInfo, splitNames, spocMembers, buildSummary } = require('../src/tracker');

test('task past due date and not completed is delayed', () => {
  assert.deepStrictEqual(delayInfo({ dueDate: '2026-10-01', status: 'In Progress' }, '2026-10-06'), { overdue: true, daysLate: 5, dueToday: false });
  assert.strictEqual(delayInfo({ dueDate: '2026-10-01', status: 'Completed' }, '2026-10-06').overdue, false);
  assert.strictEqual(delayInfo({ dueDate: '2026-10-06', status: 'TBD' }, '2026-10-06').dueToday, true);
  assert.strictEqual(delayInfo({ dueDate: '', status: 'TBD' }, '2026-10-06').overdue, false);
  assert.strictEqual(delayInfo({ dueDate: '2026-10-01', status: 'Done' }, '2026-10-06').overdue, false);
});

test('SPOC text maps to team members', () => {
  assert.deepStrictEqual(splitNames('Asha / Ravi'), ['Asha', 'Ravi']);
  const team = [{ name: 'Asha', email: 'g@x.com' }, { name: 'Ravi Kumar', email: 'n@x.com' }, { name: 'Dev K' }];
  assert.deepStrictEqual(spocMembers(team, 'Asha / Ravi').map(m => m.email), ['g@x.com', 'n@x.com']);
  assert.deepStrictEqual(spocMembers(team, 'Dev K').map(m => m.name), ['Dev K']);
});

test('summary counts delayed, due soon and updated today', () => {
  const db = {
    tasks: [
      { id: 1, brick: 'TOFU', status: 'In Progress', dueDate: '2026-10-02' },
      { id: 2, brick: 'MOFU', status: 'Completed', dueDate: '2026-10-02' },
      { id: 3, brick: 'BOFU', status: 'TBD', dueDate: '2026-10-08' },
      { id: 4, brick: 'BOFU', status: 'Blocked', dueDate: '' },
    ],
    meetings: [{ id: 1, title: 'M', date: '2026-10-06', actionItems: [{ id: 1, text: 'x', dueDate: '2026-10-05', status: 'Open' }] }],
    activity: [{ at: '2026-10-06T08:00:00Z', type: 'task', id: 2, user: 'G', changes: [{ field: 'status', label: 'Status', from: 'In Progress', to: 'Completed' }] }],
  };
  const s = buildSummary(db, '2026-10-06');
  assert.deepStrictEqual(s.overdue.map(t => t.id), [1]);
  assert.deepStrictEqual(s.dueSoon.map(t => t.id), [3]);
  assert.deepStrictEqual(s.blocked.map(t => t.id), [4]);
  assert.deepStrictEqual(s.completedToday.map(t => t.id), [2]);
  assert.strictEqual(s.overdueActions.length, 1);
  assert.strictEqual(s.meetingsToday.length, 1);
  assert.strictEqual(s.completion, 25);
});
