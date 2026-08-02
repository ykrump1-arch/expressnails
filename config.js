import http from 'node:http';
import { Bot, InlineKeyboard, Keyboard, InputFile, GrammyError, HttpError } from 'grammy';

import { db, save, saveNow, setDbErrorHandler } from './db.js';
import {
  BOT_TOKEN, ADMIN_IDS, MASTERS, WORK_SLOTS, SERVICE, SALON_NAME,
  REMIND_BEFORE_MS, FOLLOWUP_AFTER_MS, TZ_HOURS, ALERT_IDS,
} from './config.js';
import {
  esc, dateStr, dateRange, fmtDate, fmtDateShort, slotTs, masterName, isAdmin,
  freeSlots, masterHasFree, addSlot, removeSlot, isBooked, cleanupSlots,
  seedRandomSlots, ensureHorizon,
} from './utils.js';

if (!BOT_TOKEN) throw new Error('Не задан BOT_TOKEN в переменных окружения');

const bot = new Bot(BOT_TOKEN);

// Временные состояния диалога (телефон, рассылка) — в памяти, это ок
const pending = new Map();

const BTN_BOOK = '💅 Записаться';
const BTN_MY = '📋 Мои записи';
const BTN_ADMIN = '⚙️ Админка';

// ───────────────────────────────────────────────
//  ПОЛЬЗОВАТЕЛИ / АНАЛИТИКА
// ───────────────────────────────────────────────

// Красивые названия для меток источников.
// Метки, которых тут нет, покажутся как есть — можно дописывать свои.
const SOURCE_LABELS = {
  instagram: '📷 Instagram (шапка профиля)',
  stories: '📱 Сторис',
  vizitka: '🪪 Визитка / QR',
  telegram: '✈️ Telegram-канал',
  salon: '🏠 В салоне',
  reklama: '💰 Реклама',
  '(без метки)': '🔗 Прямой переход',
};

// Достаём метку источника из ссылки вида t.me/bot?start=instagram
function startPayload(ctx) {
  const t = ctx.message?.text;
  if (!t || !t.startsWith('/start')) return null;
  const raw = t.split(' ')[1];
  if (!raw) return null;
  return raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || null;
}

function touchUser(ctx) {
  const u = ctx.from;
  if (!u) return null;
  const id = String(u.id);
  const payload = startPayload(ctx);
  db.users[id] ??= {
    id: u.id,
    firstSeen: Date.now(),
    bookings: 0,
    phone: null,
    source: payload,
  };
  const rec = db.users[id];
  // если человек уже был в базе без метки, а теперь пришёл по ссылке — запишем
  if (!rec.source && payload) rec.source = payload;
  rec.name = [u.first_name, u.last_name].filter(Boolean).join(' ');
  rec.username = u.username || null;
  rec.lastSeen = Date.now();
  save();
  return rec;
}

function mainKb(ctx) {
  const kb = new Keyboard().text(BTN_BOOK).text(BTN_MY);
  if (isAdmin(ctx.from?.id)) kb.row().text(BTN_ADMIN);
  return kb.resized();
}

async function notifyAdmins(text) {
  for (const id of ADMIN_IDS) {
    try {
      await bot.api.sendMessage(id, text, { parse_mode: 'HTML' });
    } catch (e) {
      console.error('[admin notify]', id, e.message);
    }
  }
}

// ───────────────────────────────────────────────
//  ТРЕВОГИ ДЛЯ АДМИНОВ
// ───────────────────────────────────────────────

// Чтобы одна повторяющаяся ошибка не завалила телефон сотней сообщений
const alertSeen = new Map();
const ALERT_COOLDOWN = 10 * 60 * 1000; // одну и ту же ошибку — не чаще раза в 10 минут

async function alertAdmins(title, detail = '') {
  const key = title + detail.slice(0, 120);
  const now = Date.now();
  const last = alertSeen.get(key) || 0;
  if (now - last < ALERT_COOLDOWN) return;
  alertSeen.set(key, now);

  const time = new Date(now + TZ_HOURS * 3600 * 1000).toISOString().slice(11, 16);
  const text =
    `🚨 <b>${esc(title)}</b>\n` +
    `Время: ${time} (Ташкент)\n` +
    (detail ? `\n<code>${esc(detail.slice(0, 600))}</code>` : '');

  for (const id of ALERT_IDS) {
    try {
      await bot.api.sendMessage(id, text, { parse_mode: 'HTML' });
    } catch (e) {
      console.error('[alert]', id, e.message);
    }
  }
}

setDbErrorHandler((msg) => {
  alertAdmins('Не удалось сохранить базу', msg).catch(() => {});
});

// ───────────────────────────────────────────────
//  КЛИЕНТСКИЙ СЦЕНАРИЙ
// ───────────────────────────────────────────────

function mastersKb() {
  const kb = new InlineKeyboard();
  MASTERS.forEach((m, i) => {
    const free = masterHasFree(m.id);
    kb.text(`${free ? '' : '⛔️ '}${m.name}`, `m:${m.id}`);
    if (i % 2 === 1) kb.row();
  });
  return kb;
}

async function showMasters(ctx, edit = false) {
  const text =
    `<b>${esc(SERVICE)}</b>\nВыберите мастера:\n\n` +
    MASTERS.map((m) => {
      const n = dateRange().reduce((s, ds) => s + freeSlots(m.id, ds).length, 0);
      return `• <b>${esc(m.name)}</b> — ${n ? `свободных окон: ${n}` : 'нет свободных окон'}`;
    }).join('\n');

  const opts = { parse_mode: 'HTML', reply_markup: mastersKb() };
  if (edit) await ctx.editMessageText(text, opts).catch(() => ctx.reply(text, opts));
  else await ctx.reply(text, opts);
}

bot.command('start', async (ctx) => {
  touchUser(ctx);
  await ctx.reply(
    `Здравствуйте! 🌸\nЭто бот записи <b>${esc(SALON_NAME)}</b>.\n\n` +
      `Здесь можно посмотреть свободное время мастеров и записаться на ${esc(SERVICE.toLowerCase())} за пару касаний.`,
    { parse_mode: 'HTML', reply_markup: mainKb(ctx) }
  );
  await showMasters(ctx);
});

bot.command('help', async (ctx) => {
  let t =
    '<b>Команды</b>\n' +
    '/start — начать\n' +
    '/book — записаться\n' +
    '/my — мои записи\n';
  if (isAdmin(ctx.from.id)) {
    t +=
      '\n<b>Админ</b>\n' +
      '/slots — редактировать свободные окна\n' +
      '/bookings — ближайшие записи\n' +
      '/clients — список записывавшихся\n' +
      '/stats — аналитика\n' +
      '/reset — обнулить базу\n' +
      '/demo — заполнить расписание для показа\n' +
      '/export — выгрузка CSV\n' +
      '/broadcast — рассылка\n' +
      '/id — узнать свой Telegram ID';
  }
  await ctx.reply(t, { parse_mode: 'HTML' });
});

bot.command('id', (ctx) => ctx.reply(`Ваш Telegram ID: <code>${ctx.from.id}</code>`, { parse_mode: 'HTML' }));

bot.command('book', async (ctx) => {
  touchUser(ctx);
  await showMasters(ctx);
});

// — выбор мастера → даты
bot.callbackQuery(/^m:([^:]+)$/, async (ctx) => {
  const mId = ctx.match[1];
  await ctx.answerCallbackQuery();

  const days = dateRange().filter((ds) => freeSlots(mId, ds).length > 0);
  if (!days.length) {
    return ctx.editMessageText(
      `У мастера <b>${esc(masterName(mId))}</b> пока нет свободных окон.\nПопробуйте выбрать другого мастера.`,
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('← К мастерам', 'back:m') }
    );
  }

  const kb = new InlineKeyboard();
  days.forEach((ds, i) => {
    kb.text(`${fmtDateShort(ds)} · ${freeSlots(mId, ds).length}`, `d:${mId}:${ds}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row().text('← К мастерам', 'back:m');

  await ctx.editMessageText(
    `Мастер: <b>${esc(masterName(mId))}</b>\nВыберите день:`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
});

// — выбор даты → время
bot.callbackQuery(/^d:([^:]+):([^:]+)$/, async (ctx) => {
  const [, mId, ds] = ctx.match;
  await ctx.answerCallbackQuery();

  const times = freeSlots(mId, ds);
  if (!times.length) {
    return ctx.editMessageText('Это время уже разобрали 😔 Выберите другой день.', {
      reply_markup: new InlineKeyboard().text('← К дням', `m:${mId}`),
    });
  }

  const kb = new InlineKeyboard();
  times.forEach((t, i) => {
    kb.text(t, `t:${mId}:${ds}:${t}`);
    if (i % 3 === 2) kb.row();
  });
  kb.row().text('← К дням', `m:${mId}`);

  await ctx.editMessageText(
    `Мастер: <b>${esc(masterName(mId))}</b>\nДень: <b>${fmtDate(ds)}</b>\n\nСвободное время:`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
});

// — выбор времени → подтверждение / запрос телефона
bot.callbackQuery(/^t:([^:]+):([^:]+):(.+)$/, async (ctx) => {
  const [, mId, ds, time] = ctx.match;
  await ctx.answerCallbackQuery();

  if (!freeSlots(mId, ds).includes(time)) {
    return ctx.editMessageText('Это окно только что заняли. Выберите другое время.', {
      reply_markup: new InlineKeyboard().text('← Ко времени', `d:${mId}:${ds}`),
    });
  }

  const user = touchUser(ctx);
  if (!user?.phone) {
    pending.set(ctx.from.id, { step: 'phone', mId, ds, time });
    return ctx.reply(
      'Остался последний шаг — оставьте номер телефона.\n' +
        'Нажмите кнопку ниже или напишите номер сообщением.',
      {
        reply_markup: new Keyboard().requestContact('📱 Отправить мой номер').resized().oneTime(),
      }
    );
  }

  await ctx.editMessageText(confirmText(mId, ds, time, user.phone), {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard()
      .text('✅ Подтвердить запись', `c:${mId}:${ds}:${time}`)
      .row()
      .text('← Назад', `d:${mId}:${ds}`),
  });
});

function confirmText(mId, ds, time, phone) {
  return (
    '<b>Проверьте запись:</b>\n\n' +
    `Услуга: ${esc(SERVICE)}\n` +
    `Мастер: <b>${esc(masterName(mId))}</b>\n` +
    `Дата: <b>${fmtDate(ds)}</b>\n` +
    `Время: <b>${time}</b>\n` +
    `Телефон: ${esc(phone)}`
  );
}

// — телефон
bot.on('message:contact', async (ctx) => {
  const st = pending.get(ctx.from.id);
  const user = touchUser(ctx);
  user.phone = ctx.message.contact.phone_number;
  save();
  await ctx.reply('Номер сохранён ✅', { reply_markup: mainKb(ctx) });
  if (st?.step === 'phone') {
    pending.delete(ctx.from.id);
    await ctx.reply(confirmText(st.mId, st.ds, st.time, user.phone), {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('✅ Подтвердить запись', `c:${st.mId}:${st.ds}:${st.time}`)
        .row()
        .text('← Назад', `d:${st.mId}:${st.ds}`),
    });
  }
});

// — подтверждение записи
bot.callbackQuery(/^c:([^:]+):([^:]+):(.+)$/, async (ctx) => {
  const [, mId, ds, time] = ctx.match;
  const user = touchUser(ctx);

  if (!freeSlots(mId, ds).includes(time) || isBooked(mId, ds, time)) {
    await ctx.answerCallbackQuery({ text: 'Увы, окно уже заняли', show_alert: true });
    return ctx.editMessageText('Это окно только что заняли. Выберите другое время.', {
      reply_markup: new InlineKeyboard().text('← Ко времени', `d:${mId}:${ds}`),
    });
  }

  const booking = {
    id: Math.random().toString(36).slice(2, 10),
    userId: ctx.from.id,
    name: user.name,
    username: user.username,
    phone: user.phone,
    masterId: mId,
    service: SERVICE,
    date: ds,
    time,
    ts: slotTs(ds, time),
    createdAt: Date.now(),
    status: 'active',
    reminded: false,
    followupSent: false,
    repeat: user.bookings > 0,
  };

  db.bookings.push(booking);
  user.bookings += 1;
  removeSlot(mId, ds, time);
  saveNow();

  await ctx.answerCallbackQuery({ text: 'Записали!' });
  await ctx.editMessageText(
    '✅ <b>Вы записаны!</b>\n\n' +
      `${esc(SERVICE)} · <b>${esc(masterName(mId))}</b>\n` +
      `${fmtDate(ds)} в <b>${time}</b>\n\n` +
      'За 2 часа до визита пришлём напоминание.\n' +
      'Отменить или перенести можно в разделе «Мои записи».',
    { parse_mode: 'HTML' }
  );

  await notifyAdmins(
    '🆕 <b>Новая запись</b>\n' +
      `${esc(masterName(mId))} — ${fmtDate(ds)}, ${time}\n` +
      `Клиент: ${esc(user.name)}${user.username ? ' (@' + esc(user.username) + ')' : ''}\n` +
      `Телефон: ${esc(user.phone || '—')}\n` +
      `${booking.repeat ? '♻️ Повторный клиент' : '🌱 Первая запись'}`
  );
});

bot.callbackQuery('back:m', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showMasters(ctx, true);
});

// — мои записи
async function showMy(ctx) {
  const uid = ctx.from.id;
  const list = db.bookings
    .filter((b) => b.userId === uid && b.status === 'active' && b.ts > Date.now())
    .sort((a, b) => a.ts - b.ts);

  if (!list.length) {
    return ctx.reply('У вас пока нет активных записей.', {
      reply_markup: new InlineKeyboard().text('💅 Записаться', 'back:m'),
    });
  }

  for (const b of list) {
    await ctx.reply(
      `${esc(b.service)} · <b>${esc(masterName(b.masterId))}</b>\n${fmtDate(b.date)} в <b>${b.time}</b>`,
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('❌ Отменить запись', `x:${b.id}`),
      }
    );
  }
}

bot.command('my', (ctx) => showMy(ctx));

bot.callbackQuery(/^x:(.+)$/, async (ctx) => {
  const b = db.bookings.find((x) => x.id === ctx.match[1]);
  if (!b || b.status !== 'active') {
    return ctx.answerCallbackQuery({ text: 'Запись уже неактивна', show_alert: true });
  }
  if (b.userId !== ctx.from.id && !isAdmin(ctx.from.id)) {
    return ctx.answerCallbackQuery({ text: 'Нет доступа', show_alert: true });
  }

  b.status = 'cancelled';
  b.cancelledAt = Date.now();
  if (b.ts > Date.now()) addSlot(b.masterId, b.date, b.time); // окно снова свободно
  saveNow();

  await ctx.answerCallbackQuery({ text: 'Запись отменена' });
  await ctx.editMessageText(
    `❌ Запись отменена\n<s>${esc(masterName(b.masterId))} · ${fmtDate(b.date)} в ${b.time}</s>`,
    { parse_mode: 'HTML' }
  );
  await notifyAdmins(
    `❌ <b>Отмена</b>\n${esc(masterName(b.masterId))} — ${fmtDate(b.date)}, ${b.time}\n` +
      `Клиент: ${esc(b.name)} ${esc(b.phone || '')}`
  );
});

// ───────────────────────────────────────────────
//  АДМИНКА
// ───────────────────────────────────────────────

const adminOnly = async (ctx, next) => {
  if (!isAdmin(ctx.from?.id)) {
    if (ctx.callbackQuery) return ctx.answerCallbackQuery({ text: 'Только для админов', show_alert: true });
    return ctx.reply('Команда доступна только администратору.');
  }
  return next();
};

function adminMenuKb() {
  return new InlineKeyboard()
    .text('🗓 Свободные окна', 'a:sl')
    .row()
    .text('📋 Записи', 'a:bk')
    .text('👥 Клиенты', 'a:cl')
    .row()
    .text('📊 Аналитика', 'a:st');
}

async function adminMenu(ctx, edit = false) {
  const text = '<b>Панель администратора</b>\nВыберите раздел:';
  const opts = { parse_mode: 'HTML', reply_markup: adminMenuKb() };
  if (edit) await ctx.editMessageText(text, opts).catch(() => ctx.reply(text, opts));
  else await ctx.reply(text, opts);
}

bot.command('admin', adminOnly, (ctx) => adminMenu(ctx));
bot.callbackQuery('a:menu', adminOnly, async (ctx) => {
  await ctx.answerCallbackQuery();
  await adminMenu(ctx, true);
});

// — редактор окон: мастера
async function adminMasters(ctx, edit = true) {
  const kb = new InlineKeyboard();
  MASTERS.forEach((m, i) => {
    kb.text(m.name, `a:m:${m.id}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row().text('← Меню', 'a:menu');
  const text = '🗓 <b>Редактор расписания</b>\nВыберите мастера:';
  const opts = { parse_mode: 'HTML', reply_markup: kb };
  if (edit) await ctx.editMessageText(text, opts).catch(() => ctx.reply(text, opts));
  else await ctx.reply(text, opts);
}

bot.command('slots', adminOnly, (ctx) => adminMasters(ctx, false));
bot.callbackQuery('a:sl', adminOnly, async (ctx) => {
  await ctx.answerCallbackQuery();
  await adminMasters(ctx);
});

// — редактор окон: дни
bot.callbackQuery(/^a:m:([^:]+)$/, adminOnly, async (ctx) => {
  const mId = ctx.match[1];
  await ctx.answerCallbackQuery();

  const kb = new InlineKeyboard();
  dateRange().forEach((ds, i) => {
    const n = (db.slots[mId]?.[ds] || []).length;
    kb.text(`${fmtDateShort(ds)} · ${n}`, `a:d:${mId}:${ds}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row().text('← Мастера', 'a:sl');

  await ctx.editMessageText(
    `Мастер: <b>${esc(masterName(mId))}</b>\nВыберите день (цифра — сколько окон открыто):`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
});

// — редактор окон: сетка времени
function slotGridKb(mId, ds) {
  const open = db.slots[mId]?.[ds] || [];
  const kb = new InlineKeyboard();
  WORK_SLOTS.forEach((t, i) => {
    const booked = isBooked(mId, ds, t);
    const label = booked ? `🔒 ${t}` : open.includes(t) ? `✅ ${t}` : `➕ ${t}`;
    kb.text(label, `a:t:${mId}:${ds}:${t}`);
    if (i % 3 === 2) kb.row();
  });
  kb.row().text('Открыть весь день', `a:all:${mId}:${ds}`).text('Очистить день', `a:clr:${mId}:${ds}`);
  kb.row().text('← Дни', `a:m:${mId}`).text('Меню', 'a:menu');
  return kb;
}

const gridText = (mId, ds) =>
  `<b>${esc(masterName(mId))}</b> — ${fmtDate(ds)}\n\n` +
  '✅ открыто для записи · ➕ закрыто · 🔒 уже занято клиентом\n' +
  'Нажимайте на время, чтобы открыть или закрыть окно.';

async function renderGrid(ctx, mId, ds) {
  await ctx.editMessageText(gridText(mId, ds), {
    parse_mode: 'HTML',
    reply_markup: slotGridKb(mId, ds),
  }).catch(() => {});
}

bot.callbackQuery(/^a:d:([^:]+):([^:]+)$/, adminOnly, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderGrid(ctx, ctx.match[1], ctx.match[2]);
});

bot.callbackQuery(/^a:t:([^:]+):([^:]+):(.+)$/, adminOnly, async (ctx) => {
  const [, mId, ds, t] = ctx.match;
  if (isBooked(mId, ds, t)) {
    return ctx.answerCallbackQuery({ text: 'Это время занято клиентом — отмените запись в разделе «Записи»', show_alert: true });
  }
  const open = db.slots[mId]?.[ds] || [];
  if (open.includes(t)) removeSlot(mId, ds, t);
  else addSlot(mId, ds, t);
  await ctx.answerCallbackQuery();
  await renderGrid(ctx, mId, ds);
});

bot.callbackQuery(/^a:all:([^:]+):([^:]+)$/, adminOnly, async (ctx) => {
  const [, mId, ds] = ctx.match;
  db.slots[mId] ??= {};
  db.slots[mId][ds] = [...WORK_SLOTS].filter((t) => !isBooked(mId, ds, t));
  save();
  await ctx.answerCallbackQuery({ text: 'День открыт полностью' });
  await renderGrid(ctx, mId, ds);
});

bot.callbackQuery(/^a:clr:([^:]+):([^:]+)$/, adminOnly, async (ctx) => {
  const [, mId, ds] = ctx.match;
  db.slots[mId] ??= {};
  db.slots[mId][ds] = [];
  save();
  await ctx.answerCallbackQuery({ text: 'Окна закрыты' });
  await renderGrid(ctx, mId, ds);
});

// — ближайшие записи
function bookingsText() {
  const now = Date.now();
  const list = db.bookings
    .filter((b) => b.status === 'active' && b.ts > now)
    .sort((a, b) => a.ts - b.ts)
    .slice(0, 40);

  if (!list.length) return '📋 Активных записей нет.';

  const byDate = {};
  for (const b of list) (byDate[b.date] ??= []).push(b);

  let out = `📋 <b>Ближайшие записи</b> (${list.length})\n`;
  for (const ds of Object.keys(byDate).sort()) {
    out += `\n<b>${fmtDate(ds)}</b>\n`;
    for (const b of byDate[ds]) {
      out += `${b.time} · ${esc(masterName(b.masterId))} — ${esc(b.name)}` +
        `${b.username ? ' @' + esc(b.username) : ''} ${esc(b.phone || '')}\n`;
    }
  }
  return out;
}

bot.command('bookings', adminOnly, (ctx) => ctx.reply(bookingsText(), { parse_mode: 'HTML' }));
bot.callbackQuery('a:bk', adminOnly, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(bookingsText(), {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('← Меню', 'a:menu'),
  }).catch(() => {});
});

// — список клиентов, которые записывались
function clientsText() {
  const map = new Map();
  for (const b of db.bookings) {
    const k = b.userId;
    const rec = map.get(k) || { name: b.name, username: b.username, phone: b.phone, total: 0, cancelled: 0, last: 0 };
    rec.total += 1;
    if (b.status === 'cancelled') rec.cancelled += 1;
    rec.last = Math.max(rec.last, b.ts);
    rec.phone = b.phone || rec.phone;
    map.set(k, rec);
  }
  if (!map.size) return '👥 Пока никто не записывался.';

  const rows = [...map.values()].sort((a, b) => b.total - a.total || b.last - a.last);
  let out = `👥 <b>Клиенты, которые записывались</b> — всего ${rows.length}\n\n`;
  rows.slice(0, 50).forEach((r, i) => {
    out += `${i + 1}. ${esc(r.name)}${r.username ? ' @' + esc(r.username) : ''} — ${esc(r.phone || 'нет тел.')}\n` +
      `    записей: ${r.total}${r.cancelled ? `, отмен: ${r.cancelled}` : ''}, последняя: ${fmtDateShort(new Date(r.last + 5 * 3600 * 1000).toISOString().slice(0, 10))}\n`;
  });
  if (rows.length > 50) out += `\n…и ещё ${rows.length - 50}. Полный список — /export`;
  return out;
}

bot.command('clients', adminOnly, (ctx) => ctx.reply(clientsText(), { parse_mode: 'HTML' }));
bot.callbackQuery('a:cl', adminOnly, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(clientsText(), {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('← Меню', 'a:menu'),
  }).catch(() => {});
});

// — аналитика
function statsText() {
  const now = Date.now();
  const all = db.bookings;
  const active = all.filter((b) => b.status === 'active');
  const cancelled = all.filter((b) => b.status === 'cancelled');
  const done = all.filter((b) => b.status === 'done');
  const users = Object.values(db.users);

  const inLast = (days) => all.filter((b) => b.createdAt > now - days * 864e5).length;

  const byMaster = MASTERS.map((m) => ({
    name: m.name,
    n: all.filter((b) => b.masterId === m.id && b.status !== 'cancelled').length,
  })).sort((a, b) => b.n - a.n);

  const byTime = {};
  for (const b of all) if (b.status !== 'cancelled') byTime[b.time] = (byTime[b.time] || 0) + 1;
  const topTimes = Object.entries(byTime).sort((a, b) => b[1] - a[1]).slice(0, 3);

  const clientIds = new Set(all.map((b) => b.userId));
  const repeat = [...clientIds].filter((id) => all.filter((b) => b.userId === id && b.status !== 'cancelled').length > 1);

  const conv = users.length ? Math.round((clientIds.size / users.length) * 100) : 0;
  const cancelRate = all.length ? Math.round((cancelled.length / all.length) * 100) : 0;

  const openSlots = MASTERS.reduce(
    (s, m) => s + dateRange().reduce((x, ds) => x + freeSlots(m.id, ds).length, 0), 0
  );

  // — откуда пришли клиенты
  const bookedSet = new Set(all.filter((b) => b.status !== 'cancelled').map((b) => b.userId));
  const srcMap = {};
  for (const u of users) {
    const key = u.source || '(без метки)';
    srcMap[key] ??= { started: 0, booked: 0 };
    srcMap[key].started++;
    if (bookedSet.has(u.id)) srcMap[key].booked++;
  }
  const bySource = Object.entries(srcMap)
    .sort((a, b) => b[1].started - a[1].started)
    .map(([key, v]) => {
      const pct = v.started ? Math.round((v.booked / v.started) * 100) : 0;
      return `${SOURCE_LABELS[key] || key}: ${v.started} → записались ${v.booked} (${pct}%)`;
    });

  return (
    '📊 <b>Аналитика</b>\n\n' +
    `<b>Записи</b>\nВсего: ${all.length}\n` +
    `Активных: ${active.length} · Состоялось: ${done.length} · Отменено: ${cancelled.length} (${cancelRate}%)\n` +
    `За 7 дней: ${inLast(7)} · за 30 дней: ${inLast(30)}\n\n` +
    `<b>Клиенты</b>\nЗапустили бота: ${users.length}\n` +
    `Записались хотя бы раз: ${clientIds.size} (конверсия ${conv}%)\n` +
    `Вернулись повторно: ${repeat.length}\n\n` +
    `<b>По мастерам</b>\n${byMaster.map((m) => `${m.name}: ${m.n}`).join('\n')}\n\n` +
    `<b>Популярное время</b>\n${topTimes.length ? topTimes.map(([t, n]) => `${t} — ${n}`).join('\n') : '—'}\n\n` +
    `<b>Откуда пришли</b>\n${bySource.length ? bySource.join('\n') : '—'}\n\n` +
    `<b>Загрузка</b>\nСвободных окон на ${dateRange().length} дней: ${openSlots}`
  );
}

// — демо-расписание для показа клиенту: всем мастерам открыты все рабочие часы
bot.command('demo', adminOnly, async (ctx) => {
  for (const m of MASTERS) {
    db.slots[m.id] ??= {};
    for (const ds of dateRange()) db.slots[m.id][ds] = [...WORK_SLOTS];
  }
  saveNow();
  await ctx.reply(
    `✅ Расписание заполнено для показа.\n` +
      `${MASTERS.length} мастеров × ${dateRange().length} дней × ${WORK_SLOTS.length} окон.\n\n` +
      `Записи не тронуты. Когда салон даст настоящий график — закроешь лишнее через /slots.`
  );
});

bot.command('stats', adminOnly, (ctx) => ctx.reply(statsText(), { parse_mode: 'HTML' }));

// — обнуление базы (только админ, только с явным подтверждением словом)
bot.command('reset', adminOnly, async (ctx) => {
  const arg = (ctx.match || '').trim().toUpperCase();

  if (arg === 'ПОДТВЕРЖДАЮ') {
    const n = db.bookings.length;
    const u = Object.keys(db.users).length;
    db.bookings = [];
    db.users = {};
    saveNow();
    return ctx.reply(
      `🧹 Аналитика обнулена.\nУдалено записей: ${n}, клиентов: ${u}.\nРасписание осталось на месте.`
    );
  }

  if (arg === 'ВСЁ' || arg === 'ВСЕ') {
    const n = db.bookings.length;
    db.bookings = [];
    db.users = {};
    db.slots = {};
    db.meta.seeded = true; // чтобы случайные окна не насыпались заново
    ensureHorizon();
    saveNow();
    return ctx.reply(
      `🧹 Стёрто всё.\nУдалено записей: ${n}.\nРасписание пустое — открой окна через /slots.`
    );
  }

  await ctx.reply(
    '⚠️ <b>Обнуление базы</b>\n\n' +
      'Действие необратимо. Выбери, что стереть, и отправь команду целиком:\n\n' +
      '<code>/reset ПОДТВЕРЖДАЮ</code>\n' +
      '— удалит все записи и клиентов. Аналитика обнулится, расписание останется.\n\n' +
      '<code>/reset ВСЁ</code>\n' +
      '— удалит записи, клиентов и расписание. Все окна закроются, тестовые случайные тоже.\n\n' +
      `Сейчас в базе: записей ${db.bookings.length}, клиентов ${Object.keys(db.users).length}.\n\n` +
      '💡 Перед обнулением полезно сделать /export — выгрузишь историю в файл.',
    { parse_mode: 'HTML' }
  );
});
bot.callbackQuery('a:st', adminOnly, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(statsText(), {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('← Меню', 'a:menu'),
  }).catch(() => {});
});

// — выгрузка CSV
bot.command('export', adminOnly, async (ctx) => {
  const head = 'id;создана;клиент;username;телефон;мастер;услуга;дата;время;статус;повторный\n';
  const rows = db.bookings
    .slice()
    .sort((a, b) => a.ts - b.ts)
    .map((b) =>
      [
        b.id,
        new Date(b.createdAt).toISOString(),
        (b.name || '').replace(/;/g, ','),
        b.username || '',
        b.phone || '',
        masterName(b.masterId),
        b.service || SERVICE,
        b.date,
        b.time,
        b.status,
        b.repeat ? 'да' : 'нет',
      ].join(';')
    )
    .join('\n');

  const csv = '\uFEFF' + head + rows; // BOM — чтобы Excel не ломал кириллицу
  await ctx.replyWithDocument(new InputFile(Buffer.from(csv, 'utf8'), 'bookings.csv'));
});

// — рассылка (текстом или картинкой с подписью)
async function runBroadcast(ctx, { text, photo }) {
  const users = Object.values(db.users);
  if (!users.length) return ctx.reply('Пока некому рассылать — бота никто не запускал.');

  await ctx.reply(`Начинаю рассылку по ${users.length} получателям…`);

  let ok = 0, fail = 0;
  for (const u of users) {
    try {
      if (photo) await bot.api.sendPhoto(u.id, photo, { caption: text || undefined });
      else await bot.api.sendMessage(u.id, text);
      ok++;
    } catch {
      fail++;
    }
    await new Promise((r) => setTimeout(r, 60)); // не упираемся в лимиты Telegram
  }
  await ctx.reply(`Рассылка завершена. Доставлено: ${ok}, не доставлено: ${fail}`);
}

bot.command('broadcast', adminOnly, async (ctx) => {
  const text = ctx.match?.trim();
  if (!text) {
    return ctx.reply(
      'Как отправить рассылку:\n\n' +
        '• текстом — /broadcast ваш текст\n' +
        '• картинкой — прикрепите фото и в подписи к нему напишите /broadcast и текст'
    );
  }
  await runBroadcast(ctx, { text });
});

// фото с подписью, начинающейся на /broadcast
bot.on('message:photo', async (ctx) => {
  const caption = (ctx.message.caption || '').trim();
  if (!caption.startsWith('/broadcast')) return; // обычное фото от клиента — молча игнорируем
  if (!isAdmin(ctx.from.id)) return ctx.reply('Команда доступна только администратору.');

  const text = caption.replace(/^\/broadcast\s*/, '').trim();
  const photo = ctx.message.photo.at(-1).file_id; // последний размер — максимальное качество
  await runBroadcast(ctx, { text, photo });
});

// ───────────────────────────────────────────────
//  ТЕКСТОВЫЕ КНОПКИ И ВВОД
// ───────────────────────────────────────────────

bot.on('message:text', async (ctx) => {
  const t = ctx.message.text.trim();
  touchUser(ctx);

  if (t === BTN_BOOK) return showMasters(ctx);
  if (t === BTN_MY) return showMy(ctx);
  if (t === BTN_ADMIN && isAdmin(ctx.from.id)) return adminMenu(ctx);

  const st = pending.get(ctx.from.id);
  if (st?.step === 'phone') {
    const digits = t.replace(/[^\d+]/g, '');
    if (digits.replace(/\D/g, '').length < 9) {
      return ctx.reply('Похоже, номер неполный. Напишите в формате +998 90 123 45 67');
    }
    const user = touchUser(ctx);
    user.phone = digits;
    save();
    pending.delete(ctx.from.id);
    await ctx.reply('Номер сохранён ✅', { reply_markup: mainKb(ctx) });
    return ctx.reply(confirmText(st.mId, st.ds, st.time, digits), {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('✅ Подтвердить запись', `c:${st.mId}:${st.ds}:${st.time}`)
        .row()
        .text('← Назад', `d:${st.mId}:${st.ds}`),
    });
  }

  if (t.startsWith('/')) return;
  await ctx.reply('Нажмите «💅 Записаться», чтобы выбрать мастера и время.', {
    reply_markup: mainKb(ctx),
  });
});

// ───────────────────────────────────────────────
//  ПЛАНИРОВЩИК: напоминания и повторная запись
// ───────────────────────────────────────────────

async function tick() {
  const now = Date.now();
  let changed = false;

  for (const b of db.bookings) {
    // 1) напоминание за 2 часа
    if (b.status === 'active' && !b.reminded && b.ts > now && b.ts - now <= REMIND_BEFORE_MS) {
      try {
        await bot.api.sendMessage(
          b.userId,
          `⏰ <b>Напоминание</b>\n\nСегодня в <b>${b.time}</b> вы записаны на ${esc(b.service || SERVICE).toLowerCase()} ` +
            `к мастеру <b>${esc(masterName(b.masterId))}</b>.\n\nЖдём вас! 🌸`,
          {
            parse_mode: 'HTML',
            reply_markup: new InlineKeyboard().text('❌ Не смогу прийти', `x:${b.id}`),
          }
        );
        b.reminded = true;
        changed = true;
      } catch (e) {
        console.error('[remind]', b.id, e.message);
        b.reminded = true; // не долбим заблокировавших бота
        changed = true;
      }
    }

    // 2) визит прошёл → помечаем как состоявшийся
    if (b.status === 'active' && now > b.ts + 2 * 60 * 60 * 1000) {
      b.status = 'done';
      changed = true;
    }

    // 3) через 2 недели — предложение записаться снова
    if (b.status === 'done' && !b.followupSent && now >= b.ts + FOLLOWUP_AFTER_MS) {
      try {
        await bot.api.sendMessage(
          b.userId,
          `🌸 Прошло две недели с визита к мастеру <b>${esc(masterName(b.masterId))}</b>.\n\n` +
            'Самое время обновить маникюр — выберите удобное окно, пока их разбирают.',
          {
            parse_mode: 'HTML',
            reply_markup: new InlineKeyboard()
              .text('💅 Записаться снова', `m:${b.masterId}`)
              .row()
              .text('Выбрать другого мастера', 'back:m'),
          }
        );
      } catch (e) {
        console.error('[followup]', b.id, e.message);
      }
      b.followupSent = true;
      changed = true;
    }
  }

  if (changed) saveNow();
  cleanupSlots();
  ensureHorizon();
}

setInterval(() => tick().catch((e) => console.error('[tick]', e)), 60 * 1000);

// ───────────────────────────────────────────────
//  ЗАПУСК
// ───────────────────────────────────────────────

bot.catch(async (err) => {
  const e = err.error;
  let title = 'Ошибка в боте';
  let detail = '';

  if (e instanceof GrammyError) {
    title = 'Telegram отклонил запрос';
    detail = e.description;
  } else if (e instanceof HttpError) {
    title = 'Нет связи с Telegram';
    detail = String(e.message || e);
  } else {
    detail = (e && e.stack) ? e.stack : String(e);
  }

  const ctx = err.ctx;
  const who = ctx?.from
    ? `\nКто: ${ctx.from.first_name || ''} ${ctx.from.username ? '@' + ctx.from.username : ''} (${ctx.from.id})`
    : '';
  const what = ctx?.message?.text ? `\nЧто нажал: ${ctx.message.text}` : '';

  console.error('[bot.catch]', title, detail);
  await alertAdmins(title, detail + who + what).catch(() => {});

  // Клиент не должен видеть техническую ошибку
  try {
    if (ctx?.callbackQuery) await ctx.answerCallbackQuery({ text: 'Что-то пошло не так, попробуйте ещё раз' });
    else if (ctx?.chat) await ctx.reply('Что-то пошло не так 😔 Попробуйте ещё раз или напишите нам.');
  } catch {}
});

// Падения на уровне процесса — успеваем предупредить и сохранить базу
process.on('uncaughtException', async (e) => {
  console.error('[uncaught]', e);
  await alertAdmins('Бот аварийно упал', e.stack || String(e)).catch(() => {});
  saveNow();
  setTimeout(() => process.exit(1), 1500);
});

process.on('unhandledRejection', async (e) => {
  console.error('[unhandled]', e);
  await alertAdmins('Необработанная ошибка', (e && e.stack) || String(e)).catch(() => {});
});

if (!db.meta.seeded) {
  seedRandomSlots(WORK_SLOTS);
  db.meta.seeded = true;
  saveNow();
  console.log('[init] расписание заполнено случайными окнами');
}
ensureHorizon();

try {
  await bot.api.setMyCommands([
    { command: 'start', description: 'Начать' },
    { command: 'book', description: 'Записаться' },
    { command: 'my', description: 'Мои записи' },
    { command: 'help', description: 'Помощь' },
  ]);
} catch (e) {
  console.error('[init] не удалось задать меню команд:', e.message);
}

// healthcheck для Railway
http.createServer((_, res) => { res.writeHead(200); res.end('ok'); })
  .listen(process.env.PORT || 3000);

bot.start({
  onStart: async (i) => {
    console.log(`Бот @${i.username} запущен`);
    const active = db.bookings.filter((b) => b.status === 'active').length;
    await notifyAdmins(
      `✅ <b>Бот запущен</b>\n` +
        `@${esc(i.username)}\n` +
        `В базе: записей ${db.bookings.length} (активных ${active}), клиентов ${Object.keys(db.users).length}`
    ).catch(() => {});
  },
});
tick().catch(() => {});
