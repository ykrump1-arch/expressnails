import fs from 'node:fs';
import path from 'node:path';

// На Railway подключи Volume и укажи DATA_DIR=/data — иначе база сотрётся при редеплое.
const DATA_DIR = process.env.DATA_DIR || './data';
const FILE = path.join(DATA_DIR, 'db.json');

const EMPTY = {
  slots: {},      // { masterId: { 'YYYY-MM-DD': ['10:00', '14:00'] } }
  bookings: [],   // массив записей
  users: {},      // { userId: {...} }
  meta: { seeded: false },
};

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      return { ...structuredClone(EMPTY), ...raw };
    }
  } catch (e) {
    console.error('[db] ошибка чтения:', e.message);
  }
  return structuredClone(EMPTY);
}

export const db = load();

let timer = null;

let onDbError = null;
/** Кому сообщать о проблемах с записью на диск */
export function setDbErrorHandler(fn) { onDbError = fn; }

function writeSync() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(db, null, 2));
    fs.renameSync(FILE + '.tmp', FILE);
  } catch (e) {
    console.error('[db] ошибка записи:', e.message);
    if (onDbError) { try { onDbError(e.message); } catch {} }
  }
}

/** Отложенное сохранение (склеивает частые вызовы) */
export function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    writeSync();
  }, 300);
}

export function saveNow() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  writeSync();
}

process.once('SIGINT', () => { saveNow(); process.exit(0); });
process.once('SIGTERM', () => { saveNow(); process.exit(0); });
