// Sends email through SMTP when SMTP_HOST is configured. Without it (local
// testing) emails are saved to data/outbox/ as .html files so you can open them.
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { DATA_DIR } = require('./store');

let transport;

function configured() {
  return Boolean(process.env.SMTP_HOST);
}

function getTransport() {
  if (transport) return transport;
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transport;
}

async function send({ to, subject, html, attachments = [] }) {
  to = [...new Set(to)].filter(Boolean);
  if (!to.length) return { skipped: true, reason: 'No recipients with an email address' };
  if (!configured()) {
    const dir = path.join(DATA_DIR, 'outbox');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${subject.replace(/[^\w]+/g, '_').slice(0, 60)}.html`);
    fs.writeFileSync(file, `<!-- To: ${to.join(', ')} | Subject: ${subject} -->\n${html}`);
    for (const a of attachments) fs.writeFileSync(file.replace(/\.html$/, '-' + a.filename), a.content);
    console.log(`[mail] SMTP not configured; saved preview to ${file}`);
    return { preview: file, to };
  }
  const info = await getTransport().sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: to.join(', '),
    subject,
    html,
    attachments,
  });
  console.log(`[mail] sent "${subject}" to ${to.join(', ')} (${info.messageId})`);
  return { sent: true, to, messageId: info.messageId };
}

module.exports = { send, configured };
