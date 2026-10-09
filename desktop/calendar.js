// Рабочий календарь: опубликованная ссылка .ics (Exchange/OWA, Google, любой iCalendar) → список встреч
// для наложения на сетку дня. Читаем только, ничего не пишем; в облако и бота эти данные не уходят.
// Парсер — ical.js: повторяющиеся встречи (RRULE), исключения (EXDATE, RECURRENCE-ID) и часовые пояса (VTIMEZONE).
import ICAL from 'ical.js';

const MAX_OCCURRENCES = 20000; // предохранитель от бесконечных RRULE (ежедневная с 2000 года ≈ 10 000 шагов)

function pad(n) { return String(n).padStart(2, '0'); }
function dateKey(time) { return `${time.year}-${pad(time.month)}-${pad(time.day)}`; }

/** Регистрирует VTIMEZONE из файла, чтобы TZID вроде «Russian Standard Time» разворачивались правильно. */
function registerTimezones(root) {
  for (const vtz of root.getAllSubcomponents('vtimezone')) {
    try {
      const zone = new ICAL.Timezone(vtz);
      if (zone.tzid && !ICAL.TimezoneService.has(zone.tzid)) ICAL.TimezoneService.register(zone.tzid, zone);
    } catch {
      // Кривой VTIMEZONE — время таких встреч посчитается как плавающее, остальное не ломаем.
    }
  }
}

function isCancelled(component) {
  return String(component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED';
}

function pushOccurrence(out, { uid, item, startDate, endDate }) {
  if (isCancelled(item.component)) return;
  const title = String(item.summary ?? '').trim() || 'Занято';
  const location = String(item.location ?? '').trim();
  if (startDate.isDate) {
    // Весь день: даты без времени, конец — исключительный (следующий день).
    const end = endDate && endDate.compare(startDate) > 0 ? endDate : startDate.clone().adjust(1, 0, 0, 0);
    out.push({ id: `${uid}@${dateKey(startDate)}`, uid, title, location, allDay: true, date: dateKey(startDate), endDate: dateKey(end) });
    return;
  }
  const start = startDate.toJSDate();
  const end = endDate ? endDate.toJSDate() : new Date(start.getTime() + 30 * 60_000);
  out.push({ id: `${uid}@${start.toISOString()}`, uid, title, location, allDay: false, start: start.toISOString(), end: end.toISOString() });
}

/**
 * Разбирает текст .ics и возвращает встречи, попадающие в окно [from, to] (Date).
 * Результат отсортирован по началу; каждая встреча: { id, uid, title, location, allDay, start, end | date, endDate }.
 */
export function parseIcs(text, { from, to }) {
  const root = new ICAL.Component(ICAL.parse(String(text ?? '')));
  registerTimezones(root);
  const fromTime = ICAL.Time.fromJSDate(from, true);
  const toTime = ICAL.Time.fromJSDate(to, true);

  // Группируем по UID: основная запись + исключения (RECURRENCE-ID).
  const groups = new Map();
  for (const vevent of root.getAllSubcomponents('vevent')) {
    const uid = String(vevent.getFirstPropertyValue('uid') ?? '').trim();
    if (!uid) continue;
    const group = groups.get(uid) ?? { main: null, exceptions: [] };
    if (vevent.hasProperty('recurrence-id')) group.exceptions.push(vevent); else group.main = vevent;
    groups.set(uid, group);
  }

  const out = [];
  for (const [uid, group] of groups) {
    try {
      if (!group.main) {
        // Исключения без основной записи — показываем как одиночные.
        for (const vevent of group.exceptions) {
          const item = new ICAL.Event(vevent);
          if (!item.startDate) continue;
          const endDate = item.endDate ?? item.startDate;
          if (endDate.compare(fromTime) < 0 || item.startDate.compare(toTime) > 0) continue;
          pushOccurrence(out, { uid, item, startDate: item.startDate, endDate });
        }
        continue;
      }
      const event = new ICAL.Event(group.main, { strictExceptions: false });
      for (const vevent of group.exceptions) {
        try { event.relateException(vevent); } catch { /* исключение с чужим RECURRENCE-ID — пропускаем */ }
      }
      if (!event.startDate) continue;
      if (!event.isRecurring()) {
        const endDate = event.endDate ?? event.startDate;
        if (endDate.compare(fromTime) < 0 || event.startDate.compare(toTime) > 0) continue;
        pushOccurrence(out, { uid, item: event, startDate: event.startDate, endDate });
        continue;
      }
      // Итерируем с настоящего DTSTART: подмена начала ломает правила без BYDAY и INTERVAL>1. Пропуск старых шагов дёшев.
      const iterator = event.iterator();
      let guard = 0;
      let next;
      while ((next = iterator.next()) && guard++ < MAX_OCCURRENCES) {
        if (next.compare(toTime) > 0) break;
        const details = event.getOccurrenceDetails(next);
        const endDate = details.endDate ?? details.startDate;
        if (endDate.compare(fromTime) < 0) continue;
        pushOccurrence(out, { uid, item: details.item, startDate: details.startDate, endDate });
      }
    } catch {
      // Одна битая запись не должна ронять весь календарь.
    }
  }
  const key = (event) => (event.allDay ? `${event.date}T00:00:00.000Z` : event.start);
  out.sort((a, b) => key(a).localeCompare(key(b)));
  return out;
}

/** Похоже ли тело ответа на iCalendar (а не на страницу входа SSO). */
export function looksLikeIcs(text) {
  return /^\uFEFF?\s*BEGIN:VCALENDAR/i.test(String(text ?? '').slice(0, 200));
}

/** Окно, за которое держим встречи: неделя назад и шесть недель вперёд. */
export function calendarWindow(now = new Date()) {
  const from = new Date(now.getTime() - 7 * 24 * 3600_000);
  const to = new Date(now.getTime() + 42 * 24 * 3600_000);
  return { from, to };
}
