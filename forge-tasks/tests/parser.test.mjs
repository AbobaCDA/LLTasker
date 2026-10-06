// Тесты разбора человеческого ввода. Запуск: node tests/parser.test.mjs
import { parseTaskInput, parseSnooze, normalizeOffsets, DEFAULT_OFFSETS } from '../supabase/functions/_shared/parser.js';
import { formatDue, localDateString, addLocalDays } from '../supabase/functions/_shared/time.js';

let passed = 0;
const failures = [];
function check(name, condition, details = '') {
  if (condition) {
    passed += 1;
  } else {
    failures.push(`${name}${details ? ` — ${details}` : ''}`);
    console.log(`  FAIL ${name}${details ? ` — ${details}` : ''}`);
  }
}
function group(title) {
  console.log(`\n== ${title} ==`);
}

const MSK = 'Europe/Moscow';
const UTC = 'UTC';
// Вторник, 6 октября 2026, 09:00 по Москве.
const NOW = new Date('2026-10-06T06:00:00Z');
const parse = (text, timeZone = MSK, now = NOW) => parseTaskInput(text, timeZone, now);
const iso = (date) => date.toISOString();

group('Даты и время');
{
  const t = parse('оплатить хостинг завтра 18:30 !2 #работа за день');
  check('название очищено от служебных частей', t.title === 'оплатить хостинг', t.title);
  check('«завтра 18:30» разобрано', t.dueAt === iso(new Date('2026-10-07T15:30:00Z')), String(t.dueAt));
  check('приоритет !2', t.priority === 2, String(t.priority));
  check('проект #работа', t.project === 'работа', String(t.project));
  check('напоминание «за день»', JSON.stringify(t.offsets) === '[1440]', JSON.stringify(t.offsets));
  check('срок со временем, не all-day', t.allDay === false);
}
{
  const t = parse('позвонить врачу в пятницу в 10');
  check('«в пятницу в 10» → ближайшая пятница 10:00', t.dueAt === iso(new Date('2026-10-09T07:00:00Z')), String(t.dueAt));
  check('название без даты', t.title === 'позвонить врачу', t.title);
}
{
  const friday = new Date('2026-10-09T06:00:00Z');
  const t = parse('созвон в пятницу 12:00', MSK, friday);
  check('«в пятницу» в саму пятницу → следующая неделя', t.dueAt === iso(new Date('2026-10-16T09:00:00Z')), String(t.dueAt));
}
{
  const t = parse('отчёт 06.10 19:30');
  check('«06.10 19:30» — сегодня', t.dueAt === iso(new Date('2026-10-06T16:30:00Z')), String(t.dueAt));
  const later = parse('отчёт 06.11 19:30');
  check('«06.11» — другой месяц', later.dueAt === iso(new Date('2026-11-06T16:30:00Z')), String(later.dueAt));
  const full = parse('сдать отчёт 15.11.2027 08:00');
  check('«15.11.2027 08:00» с годом', full.dueAt === iso(new Date('2027-11-15T05:00:00Z')), String(full.dueAt));
  const isoDate = parse('деплой 2027-03-01 07:00');
  check('ISO-дата «2027-03-01 07:00»', isoDate.dueAt === iso(new Date('2027-03-01T04:00:00Z')), String(isoDate.dueAt));
}
{
  const t = parse('купить фильтр завтра');
  check('«завтра» без времени → полдень и all-day', t.allDay === true && t.dueAt === iso(new Date('2026-10-07T09:00:00Z')), String(t.dueAt));
  const p = parse('послезавтра в 9 утра');
  check('«послезавтра в 9 утра»', p.dueAt === iso(new Date('2026-10-08T06:00:00Z')), String(p.dueAt));
  const r = parse('тренировка через 3 дня в 7 утра');
  check('«через 3 дня в 7 утра»', r.dueAt === iso(new Date('2026-10-09T04:00:00Z')), String(r.dueAt));
  const w = parse('отпуск через 2 недели');
  check('«через 2 недели»', w.dueAt === iso(new Date('2026-10-20T09:00:00Z')), String(w.dueAt));
  const mm = parse('оплата через 1 месяц');
  check('«через 1 месяц»', mm.dueAt === iso(new Date('2026-11-06T09:00:00Z')), String(mm.dueAt));
}
{
  const t = parse('созвон в 15');
  check('время без даты, ещё не прошло → сегодня', t.dueAt === iso(new Date('2026-10-06T12:00:00Z')), String(t.dueAt));
  const late = parse('позвонить в 9');
  check('время без даты, уже прошло → завтра', late.dueAt === iso(new Date('2026-10-07T06:00:00Z')), String(late.dueAt));
  const dots = parse('созвон 18.30');
  check('«18.30» — это время, а не дата', dots.dueAt === iso(new Date('2026-10-06T15:30:00Z')) && dots.title === 'созвон', `${dots.title} / ${dots.dueAt}`);
  const evening = parse('ужин в 7 вечера');
  check('«в 7 вечера» → 19:00', evening.dueAt === iso(new Date('2026-10-06T16:00:00Z')), String(evening.dueAt));
}
{
  const december = new Date('2026-12-20T09:00:00Z');
  const t = parse('отчёт 06.10', MSK, december);
  check('дата из прошлого уезжает на будущий год', t.dueAt === iso(new Date('2027-10-06T09:00:00Z')), String(t.dueAt));
  const worded = parse('праздник 1 января', MSK, december);
  check('«1 января» из декабря → следующий год', worded.dueAt === iso(new Date('2027-01-01T09:00:00Z')), String(worded.dueAt));
}
{
  const t = parse('сдать отчёт завтра в 18 за 2 часа +работа #офис');
  check('проект и тег разобраны по отдельности', t.project === 'офис' && t.tags.includes('работа'), `${t.project} / ${t.tags}`);
  check('напоминание «за 2 часа» = 120 минут', JSON.stringify(t.offsets) === '[120]', JSON.stringify(t.offsets));
  check('«за 2 часа» не попало в название', t.title === 'сдать отчёт', t.title);
  const combined = parse('сдать отчёт завтра в 18 за день за час');
  check('два напоминания подряд', JSON.stringify(combined.offsets) === '[60,1440]', JSON.stringify(combined.offsets));
}
{
  const t = parse('оплатить счета по будням 10:00 за 2 часа');
  check('повтор «по будням»', t.recurrence === 'weekdays', String(t.recurrence));
  check('время 10:00 сегодня', t.dueAt === iso(new Date('2026-10-06T07:00:00Z')), String(t.dueAt));
  check('напоминание за 2 часа', JSON.stringify(t.offsets) === '[120]', JSON.stringify(t.offsets));
  check('«ежедневно» → daily', parse('зарядка ежедневно в 8').recurrence === 'daily');
  check('«каждую неделю» → weekly', parse('отчёт каждую неделю в 12').recurrence === 'weekly');
  check('«ежемесячно» → monthly', parse('оплата ежемесячно в 12').recurrence === 'monthly');
}
{
  const t = parse('без напоминаний купить хлеб');
  check('«без напоминаний» → пустой набор', JSON.stringify(t.offsets) === '[]', JSON.stringify(t.offsets));
  check('фраза не попала в название', t.title === 'купить хлеб', t.title);
  const noDate = parse('подготовить отчёт за день');
  check('без срока фраза «за день» остаётся в названии', noDate.title === 'подготовить отчёт за день' && noDate.offsets === null, `${noDate.title} / ${JSON.stringify(noDate.offsets)}`);
}
{
  const t = parse('позвонить в банк важно');
  check('«важно» → приоритет 3', t.priority === 3, String(t.priority));
  const s = parse('!3 срочное дело');
  check('«!3» в начале', s.priority === 3 && s.title === 'срочное дело', `${s.priority} / ${s.title}`);
  const plain = parse('просто задача');
  check('без служебных частей: без срока и приоритет 1', plain.dueAt === null && plain.priority === 1 && plain.title === 'просто задача');
}
{
  const t = parse('созвон завтра 18:00', 'America/New_York');
  check('другой часовой пояс: формат для Нью-Йорка', formatDue(t.dueAt, 'America/New_York') === 'завтра 18:00', formatDue(t.dueAt, 'America/New_York'));
  // 18:00 в Нью-Йорке — это 01:00 следующего дня по Москве.
  check('тот же момент в Москве — уже другие сутки', t.dueAt === iso(new Date('2026-10-07T22:00:00Z')) && formatDue(t.dueAt, MSK).startsWith('08.10'), formatDue(t.dueAt, MSK));
  const berlin = parse('встреча завтра 09:00', 'Europe/Berlin');
  check('Europe/Berlin: локальное время сохранено', formatDue(berlin.dueAt, 'Europe/Berlin') === 'завтра 09:00', formatDue(berlin.dueAt, 'Europe/Berlin'));
  const utc = parse('созвон завтра 12:00', UTC);
  check('UTC: полдень остаётся полднем', utc.dueAt === iso(new Date('2026-10-07T12:00:00Z')), String(utc.dueAt));
}
{
  const t = parse('купить хлеб/молоко +дом #быт');
  check('название со слэшем сохранено', t.title === 'купить хлеб/молоко', t.title);
  check('тег и проект не в названии', t.tags.includes('дом') && t.project === 'быт', `${t.tags} / ${t.project}`);
}

group('Переносы');
{
  check('пустая строка → 15 минут', JSON.stringify(parseSnooze('')) === '{"kind":"minutes","minutes":15}');
  check('«15м»', parseSnooze('15м')?.minutes === 15);
  check('«1ч»', parseSnooze('1ч')?.minutes === 60);
  check('«2д»', parseSnooze('2д')?.minutes === 2880);
  check('«завтра 10:00»', parseSnooze('завтра 10:00')?.kind === 'tomorrow' && parseSnooze('завтра 10:00')?.hour === 10);
  check('«завтра» по умолчанию в 10:00', parseSnooze('завтра')?.hour === 10);
  check('ерунда → null', parseSnooze('абракадабра') === null);
  check('нулевой перенос отклонён', parseSnooze('0м') === null);
}

group('Наборы напоминаний');
{
  check('пусто → значения по умолчанию', JSON.stringify(normalizeOffsets([])) === JSON.stringify(DEFAULT_OFFSETS));
  check('пусто с allowEmpty → выключено', JSON.stringify(normalizeOffsets([], DEFAULT_OFFSETS, true)) === '[]');
  check('недопустимое значение отбрасывается', JSON.stringify(normalizeOffsets([999])) === JSON.stringify(DEFAULT_OFFSETS));
  check('дубликаты убираются', JSON.stringify(normalizeOffsets([60, 60, 10])) === '[60,10]');
  check('порядок сохраняется', JSON.stringify(normalizeOffsets([10, 1440, 60])) === '[10,1440,60]');
  check('больше шести значений не сохраняем', normalizeOffsets([20160, 10080, 4320, 1440, 720, 60, 10]).length === 6);
}

group('Утилиты времени');
{
  check('addLocalDays сохраняет локальное время', formatDue(addLocalDays(NOW, 1, MSK, 9, 30).toISOString(), MSK) === 'завтра 09:30', formatDue(addLocalDays(NOW, 1, MSK, 9, 30).toISOString(), MSK));
  check('переход на летнее время не сдвигает локальные сутки', localDateString(addLocalDays(new Date('2027-03-27T12:00:00Z'), 1, 'Europe/Berlin', 9, 0), 'Europe/Berlin') === '2027-03-28');
}

console.log('\n' + '='.repeat(52));
if (failures.length) {
  console.log(`Провалено: ${failures.length}, пройдено: ${passed}`);
  failures.forEach((f) => console.log(` - ${f}`));
  process.exit(1);
}
console.log(`Все проверки пройдены: ${passed}`);
