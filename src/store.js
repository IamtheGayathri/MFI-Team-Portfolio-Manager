// JSON-file store shared by the whole team.
// All reads come from memory; every change is written to disk atomically
// (write to a temp file, then rename) so a crash never leaves a half-written file.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
// Real starting data (seed/seed.json, git-ignored) if present, otherwise the generic sample.
const SEED_DIR = path.join(__dirname, '..', 'seed');
const SEED_FILE = process.env.SEED_FILE
  || (fs.existsSync(path.join(SEED_DIR, 'seed.json')) ? path.join(SEED_DIR, 'seed.json') : path.join(SEED_DIR, 'seed.example.json'));
const MAX_ACTIVITY = 3000;

let db;

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } else {
    db = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    console.log(`[store] new database created from ${path.basename(SEED_FILE)}`);
    db.version = 1;
    db.activity = [];
    db.settings = {};
    save();
  }
  db.activity ||= [];
  db.settings ||= {};
  db.meetings ||= [];
  db.alertLog ||= [];
  return db;
}

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function get() {
  return db;
}

function nextId(list) {
  return list.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
}

// Apply a change, record who did it, bump the version so open browsers refresh.
// `action` is the activity-log entry, or a function building it from fn's result.
function mutate(user, action, fn) {
  const result = fn(db);
  const entry = typeof action === 'function' ? action(result) : action;
  db.version = (db.version || 0) + 1;
  db.activity.unshift({ at: new Date().toISOString(), user: user || 'Unknown', ...entry });
  if (db.activity.length > MAX_ACTIVITY) db.activity.length = MAX_ACTIVITY;
  save();
  return result;
}

module.exports = { load, save, get, mutate, nextId, DATA_DIR };
