// ───────────────────────────────────────────────
//  НАСТРОЙКИ САЛОНА
// ───────────────────────────────────────────────

export const SALON_NAME = 'Nail Studio';
export const SERVICE = 'Маникюр';

// Мастера. id — латиницей, менять уже нельзя после запуска (на нём завязаны записи).
export const MASTERS = [
  { id: 'era', name: 'Ёра' },
  { id: 'rano', name: 'Рано' },
  { id: 'zarifa', name: 'Зарифа' },
  { id: 'sogdiana', name: 'Согдиана' },
  { id: 'nigina', name: 'Нигина' },
];

// Сетка рабочего дня — из неё админ включает/выключает окна.
export const WORK_SLOTS = [
  '09:00', '10:00', '11:00', '12:00', '13:00',
  '14:00', '15:00', '16:00', '17:00', '18:00', '19:00',
];

// На сколько дней вперёд открыта запись
export const DAYS_AHEAD = 14;

// Часовой пояс Ташкента (без перехода на летнее время)
export const TZ_OFFSET = '+05:00';
export const TZ_HOURS = 5;

// За сколько до записи напоминать
export const REMIND_BEFORE_MS = 2 * 60 * 60 * 1000; // 2 часа

// Через сколько после визита предлагать записаться снова
export const FOLLOWUP_AFTER_MS = 14 * 24 * 60 * 60 * 1000; // 2 недели

// ID админов через запятую в переменной окружения ADMIN_IDS
export const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

// Кому слать технические тревоги (падения, ошибки, сбой записи в базу).
// Если не задано — используются ADMIN_IDS.
// Задай сюда ТОЛЬКО свой ID, чтобы клиент не видел стеки ошибок.
export const TECH_IDS = (process.env.TECH_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

export const ALERT_IDS = TECH_IDS.length ? TECH_IDS : ADMIN_IDS;

export const BOT_TOKEN = process.env.BOT_TOKEN;
