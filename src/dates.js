// Date helpers. All "today" logic uses the team's time zone (default IST),
// so a task due today is not reported overdue just because the server runs in UTC.
const TZ = process.env.TZ_NAME || 'Asia/Kolkata';

function todayISO(now = new Date()) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function isoInTZ(iso) {
  return iso ? todayISO(new Date(iso)) : '';
}

function daysBetween(fromISO, toISO) {
  return Math.round((Date.parse(toISO + 'T00:00:00Z') - Date.parse(fromISO + 'T00:00:00Z')) / 86400000);
}

function addDays(iso, n) {
  const d = new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000);
  return d.toISOString().slice(0, 10);
}

function fmt(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

module.exports = { TZ, todayISO, isoInTZ, daysBetween, addDays, fmt };
