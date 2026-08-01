import { db, save } from './db.js';
import { MASTERS, TZ_OFFSET, TZ_HOURS, DAYS_AHEAD, ADMIN_IDS } from './config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

export const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Текущее время в Ташкенте, сдвинутое в UTC-представление (для получения дат) */
function tzNow() {
  return new Date(Date.now() + TZ_HOURS * 60 * 60 * 1000);
}

/** 'YYYY-MM-DD' для дня со сдвигом offset дней от сегодня (по Ташкенту) */
export function dateStr(offsetDays = 0) {
  const d = tzNow();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/** Список дат, на которые открыта запись */
export function dateRange() {
  return Array.from({ length: DAYS_AHEAD }, (_, i) => dateStr(i));
}

/** 'сб, 2 августа' */
export function fmtDate(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const today = dateStr(0);
  const tomorrow = dateStr(1);
  const label = `${WEEKDAYS[dt.getUTCDay()]}, ${d} ${MONTHS[m - 1]}`;
  if (ds === today) return `сегодня (${label})`;
  if (ds === tomorrow) return `завтра (${label})`;
  return label;
}

/** Короткая подпись для кнопки: '2 авг, сб' */
export function fmtDateShort(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${d} ${MONTHS[m - 1].slice(0, 3)}, ${WEEKDAYS[dt.getUTCDay()]}`;
}

/** Абсолютное время слота в мс (UTC) */
export function slotTs(ds, time) {
  return Date.parse(`${ds}T${time}:00${TZ_OFFSET}`);
}

export const masterName = (id) => MASTERS.find((m) => m.id === id)?.name || id;
export const isAdmin = (id) => ADMIN_IDS.includes(Number(id));

/** Свободные окна мастера на дату (прошедшее время отсекается) */
export function freeSlots(masterId, ds) {
  const list = db.slots[masterId]?.[ds] || [];
  const now = Date.now();
  return [...list].filter((t) => slotTs(ds, t) > now + 30 * 60 * 1000).sort();
}

/** Есть ли у мастера хоть одно окно в ближайшие DAYS_AHEAD дней */
export function masterHasFree(masterId) {
  return dateRange().some((ds) => freeSlots(masterId, ds).length > 0);
}

export function addSlot(masterId, ds, time) {
  db.slots[masterId] ??= {};
  db.slots[masterId][ds] ??= [];
  if (!db.slots[masterId][ds].includes(time)) {
    db.slots[masterId][ds].push(time);
    db.slots[masterId][ds].sort();
  }
  save();
}

export function removeSlot(masterId, ds, time) {
  const list = db.slots[masterId]?.[ds];
  if (!list) return;
  const i = list.indexOf(time);
  if (i !== -1) list.splice(i, 1);
  save();
}

/** Занят ли слот активной записью */
export function isBooked(masterId, ds, time) {
  return db.bookings.some(
    (b) => b.masterId === masterId && b.date === ds && b.time === time && b.status === 'active'
  );
}

/** Чистка расписания: удаляем прошедшие дни */
export function cleanupSlots() {
  const today = dateStr(0);
  let changed = false;
  for (const mId of Object.keys(db.slots)) {
    for (const ds of Object.keys(db.slots[mId])) {
      if (ds < today) {
        delete db.slots[mId][ds];
        changed = true;
      }
    }
  }
  if (changed) save();
}

/** Первичное заполнение случайными окнами */
export function seedRandomSlots(workSlots) {
  for (const m of MASTERS) {
    db.slots[m.id] ??= {};
    for (const ds of dateRange()) {
      if (db.slots[m.id][ds]) continue;
      const pool = [...workSlots];
      const count = 3 + Math.floor(Math.random() * 5); // 3–7 окон
      const picked = [];
      for (let i = 0; i < count && pool.length; i++) {
        picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
      }
      db.slots[m.id][ds] = picked.sort();
    }
  }
  save();
}

/** Догенерировать пустые дни на горизонте (чтобы админ мог их открыть) */
export function ensureHorizon() {
  for (const m of MASTERS) {
    db.slots[m.id] ??= {};
    for (const ds of dateRange()) db.slots[m.id][ds] ??= [];
  }
  save();
}

export const DAY = DAY_MS;
