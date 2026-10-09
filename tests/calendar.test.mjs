// Проверка разбора рабочего календаря (.ics): повторы, исключения, отмены, весь день, часовые пояса.
import { parseIcs, looksLikeIcs } from '../desktop/calendar.js';

let passed = 0;
function check(name, condition) {
  if (!condition) { console.error(`ПРОВАЛ: ${name}`); process.exit(1); }
  passed += 1;
}

const ics = `BEGIN:VCALENDAR
PRODID:Microsoft Exchange Server 2016
VERSION:2.0
BEGIN:VTIMEZONE
TZID:Russian Standard Time
BEGIN:STANDARD
DTSTART:16010101T000000
TZOFFSETFROM:+0300
TZOFFSETTO:+0300
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:weekly-1
SUMMARY:Еженедельный статус
DTSTART;TZID=Russian Standard Time:20260105T110000
DTEND;TZID=Russian Standard Time:20260105T113000
RRULE:FREQ=WEEKLY;BYDAY=MO
EXDATE;TZID=Russian Standard Time:20261019T110000
END:VEVENT
BEGIN:VEVENT
UID:weekly-1
RECURRENCE-ID;TZID=Russian Standard Time:20261012T110000
SUMMARY:Статус (перенос)
DTSTART;TZID=Russian Standard Time:20261012T150000
DTEND;TZID=Russian Standard Time:20261012T160000
END:VEVENT
BEGIN:VEVENT
UID:single-1
SUMMARY:Встреча с заказчиком
LOCATION:Переговорка 3
DTSTART;TZID=Russian Standard Time:20261014T140000
DTEND;TZID=Russian Standard Time:20261014T153000
END:VEVENT
BEGIN:VEVENT
UID:cancelled-1
SUMMARY:Отменённая
STATUS:CANCELLED
DTSTART;TZID=Russian Standard Time:20261014T170000
DTEND;TZID=Russian Standard Time:20261014T173000
END:VEVENT
BEGIN:VEVENT
UID:allday-1
SUMMARY:Отпуск коллеги
DTSTART;VALUE=DATE:20261015
DTEND;VALUE=DATE:20261017
END:VEVENT
BEGIN:VEVENT
UID:old-1
SUMMARY:Давно прошла
DTSTART;TZID=Russian Standard Time:20250101T100000
DTEND;TZID=Russian Standard Time:20250101T110000
END:VEVENT
BEGIN:VEVENT
UID:daily-forever
SUMMARY:Ежедневная без конца
DTSTART;TZID=Russian Standard Time:20200101T090000
DTEND;TZID=Russian Standard Time:20200101T091500
RRULE:FREQ=DAILY
END:VEVENT
END:VCALENDAR`;

const from = new Date('2026-10-11T00:00:00Z');
const to = new Date('2026-10-25T00:00:00Z');
const events = parseIcs(ics, { from, to });
const titles = events.map((e) => e.title);

check('looksLikeIcs распознаёт календарь', looksLikeIcs('\uFEFFBEGIN:VCALENDAR\r\nVERSION:2.0'));
check('looksLikeIcs отвергает HTML', !looksLikeIcs('<!doctype html><html>'));
check('одиночная встреча найдена', titles.includes('Встреча с заказчиком'));
const single = events.find((e) => e.uid === 'single-1');
check('время одиночной в UTC с учётом VTIMEZONE (+3)', single.start === '2026-10-14T11:00:00.000Z' && single.end === '2026-10-14T12:30:00.000Z');
check('место сохранено', single.location === 'Переговорка 3');
check('отменённая встреча не показывается', !titles.includes('Отменённая'));
check('давно прошедшая вне окна', !titles.includes('Давно прошла'));
const weekly = events.filter((e) => e.uid === 'weekly-1');
check('еженедельная: 12.10 перенесена (исключение), 19.10 вычеркнута (EXDATE) — остаётся перенос', weekly.length === 1 && weekly[0].title === 'Статус (перенос)' && weekly[0].start === '2026-10-12T12:00:00.000Z');
const allDay = events.find((e) => e.uid === 'allday-1');
check('весь день: даты без времени, конец исключительный', allDay.allDay === true && allDay.date === '2026-10-15' && allDay.endDate === '2026-10-17');
const daily = events.filter((e) => e.uid === 'daily-forever');
check('бесконечная ежедневная развёрнута только в окне (14 дней)', daily.length === 14);
check('ежедневная начинается с начала окна, а не с 2020 года', daily[0].start.startsWith('2026-10-11T06:00'));
check('отсортировано по началу', events.every((e, i) => i === 0 || (e.allDay ? `${e.date}T00:00:00.000Z` : e.start) >= (events[i - 1].allDay ? `${events[i - 1].date}T00:00:00.000Z` : events[i - 1].start)));
check('у каждой встречи уникальный id', new Set(events.map((e) => e.id)).size === events.length);
check('битый текст не роняет парсер', (() => { try { parseIcs('BEGIN:VCALENDAR\nEND:VCALENDAR', { from, to }); return true; } catch { return false; } })());

console.log(`Все проверки пройдены: ${passed}`);
