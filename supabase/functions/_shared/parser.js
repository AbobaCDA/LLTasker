// Разбор задачи, написанной человеческим языком.
// «оплатить хостинг завтра 18:30 !2 #работа за день» → поля строки public.tasks.
// Модуль чистый (без сети и БД): используется ботом, приложением и тестами.
import { addLocalDays, zonedParts, zonedTimeToUtc } from "./time.js";

/** @type {number[]} */
export const DEFAULT_OFFSETS = [1440, 60, 10];
/** @type {number[]} */
export const ALLOWED_OFFSETS = [20160, 10080, 4320, 1440, 720, 360, 180, 60, 30, 15, 10, 5, -5];

/** @type {Record<string, string>} */
export const RECURRENCE_LABELS = {
  daily: "каждый день",
  weekly: "каждую неделю",
  weekdays: "по будням",
  monthly: "каждый месяц",
};

const WEEKDAYS = {
  понедельник: 1, пн: 1,
  вторник: 2, вт: 2,
  среда: 3, среду: 3, ср: 3,
  четверг: 4, чт: 4,
  пятница: 5, пятницу: 5, пт: 5,
  суббота: 6, субботу: 6, сб: 6,
  воскресенье: 7, вс: 7,
};

const MONTHS = {
  январь: 1, января: 1, февраль: 2, февраля: 2, март: 3, марта: 3, апрель: 4, апреля: 4,
  май: 5, мая: 5, июнь: 6, июня: 6, июль: 7, июля: 7, август: 8, августа: 8,
  сентябрь: 9, сентября: 9, октябрь: 10, октября: 10, ноябрь: 11, ноября: 11,
  декабрь: 12, декабря: 12,
};

const MONTH_STEMS = [
  ["янв", 1], ["фев", 2], ["мар", 3], ["апр", 4], ["ма", 5], ["июн", 6],
  ["июл", 7], ["авг", 8], ["сен", 9], ["окт", 10], ["ноя", 11], ["дек", 12],
];

/** @param {string} word @returns {number | null} */
function monthFromWord(word) {
  const clean = word.toLowerCase().replace(/[^а-яё]/g, "");
  if (MONTHS[clean]) return MONTHS[clean];
  for (const [stem, value] of MONTH_STEMS) {
    if (clean.startsWith(stem)) return value;
  }
  return null;
}

/**
 * @typedef {Object} ParsedInput
 * @property {string} title
 * @property {string | null} dueAt        ISO-строка срока или null
 * @property {boolean} allDay             срок без конкретного времени
 * @property {number} priority            0..3
 * @property {string | null} project
 * @property {string[]} tags
 * @property {string | null} recurrence
 * @property {number[] | null} offsets    null = взять значения по умолчанию, [] = напоминания выключены
 * @property {string[]} matched           распознанные фрагменты (для предпросмотра в приложении)
 */

/** @param {string} value @returns {string} */
function normalizeSpaces(value) {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Основной разбор строки. now передаётся явно, чтобы поведение было воспроизводимым.
 * @param {string} raw @param {string} timeZone @param {Date} [now] @returns {ParsedInput}
 */
export function parseTaskInput(raw, timeZone, now = new Date()) {
  let text = ` ${normalizeSpaces(raw)} `;
  /** @type {string[]} */
  const matched = [];
  /** @param {RegExp} pattern @returns {RegExpMatchArray | null} */
  const eat = (pattern) => {
    const match = text.match(pattern);
    if (match) {
      matched.push(match[0].trim());
      text = text.replace(match[0], " ");
    }
    return match;
  };

  const base = zonedParts(now, timeZone);
  /** @type {{ year: number, month: number, day: number } | null} */
  let day = null;

  // Каждый следующий образец ищется только если не сработал предыдущий:
  // иначе «2 часа» из «за 2 часа» может уехать в разбор даты и пропасть из названия.
  const relative = eat(/\sчерез\s+(\d{1,3})\s*(день|дня|дней|недел[юи]?|месяц(?:а|ев)?)\s/i);
  const named = relative ? null : eat(/\s(сегодня|завтра|послезавтра)\s/i);
  const weekday = relative || named ? null : eat(/\s(?:в|во)\s+(понедельник|вторник|среду|среда|четверг|пятниц[уа]|суббот[уа]|воскресенье|пн|вт|ср|чт|пт|сб|вс)\s/i);
  const iso = relative || named || weekday ? null : eat(/\s(\d{4})-(\d{1,2})-(\d{1,2})\s/);
  const dotted = relative || named || weekday || iso ? null : eat(/\s(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\s/);
  const worded = relative || named || weekday || iso || dotted ? null : eat(/\s(\d{1,2})\s+([а-яё]{3,12})\s/i);

  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    if (unit.startsWith("недел")) {
      const parts = zonedParts(addLocalDays(now, amount * 7, timeZone, base.hour, base.minute), timeZone);
      day = { year: parts.year, month: parts.month, day: parts.day };
    } else if (unit.startsWith("месяц")) {
      const anchor = new Date(Date.UTC(base.year, base.month - 1 + amount, base.day));
      day = { year: anchor.getUTCFullYear(), month: anchor.getUTCMonth() + 1, day: anchor.getUTCDate() };
    } else {
      const parts = zonedParts(addLocalDays(now, amount, timeZone, base.hour, base.minute), timeZone);
      day = { year: parts.year, month: parts.month, day: parts.day };
    }
  } else if (named) {
    const word = named[1].toLowerCase();
    const shift = word === "сегодня" ? 0 : word === "завтра" ? 1 : 2;
    const parts = zonedParts(addLocalDays(now, shift, timeZone, base.hour, base.minute), timeZone);
    day = { year: parts.year, month: parts.month, day: parts.day };
  } else if (weekday) {
    const wanted = WEEKDAYS[weekday[1].toLowerCase()];
    const todayIndex = ((new Date(Date.UTC(base.year, base.month - 1, base.day)).getUTCDay() + 6) % 7) + 1;
    let shift = (wanted - todayIndex + 7) % 7;
    if (shift === 0) shift = 7; // «в пятницу», сказанное в пятницу, значит следующую
    const parts = zonedParts(addLocalDays(now, shift, timeZone, base.hour, base.minute), timeZone);
    day = { year: parts.year, month: parts.month, day: parts.day };
  } else if (iso) {
    day = { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  } else if (dotted) {
    const month = Number(dotted[2]);
    const rawYear = dotted[3] ? Number(dotted[3]) : null;
    const year = rawYear === null ? base.year : rawYear < 100 ? 2000 + rawYear : rawYear;
    const dayNumber = Number(dotted[1]);
    if (month >= 1 && month <= 12 && dayNumber >= 1 && dayNumber <= 31) {
      day = { year, month, day: dayNumber };
      if (rawYear === null && zonedTimeToUtc(year, month, dayNumber, 0, 0, timeZone).getTime() < now.getTime() - 86_400_000) {
        day.year = year + 1; // «06.10», сказанное в декабре, — это будущий год
      }
    } else {
      // «18.30» — это время, а не дата: возвращаем фрагмент обратно в текст.
      matched.pop();
      text = ` ${normalizeSpaces(text)} ${dotted[0].trim()} `;
    }
  } else if (worded) {
    const month = monthFromWord(worded[2]);
    const dayNumber = Number(worded[1]);
    if (month && dayNumber >= 1 && dayNumber <= 31) {
      day = { year: base.year, month, day: dayNumber };
      if (zonedTimeToUtc(day.year, month, dayNumber, 0, 0, timeZone).getTime() < now.getTime() - 86_400_000) day.year += 1;
    } else {
      matched.pop();
      text = ` ${normalizeSpaces(text)} ${worded[0].trim()} `; // это не дата — возвращаем в название
    }
  }

  // Время: «18:30», «в 18.30», «в 9», «18ч», «в 9 вечера»
  const colonTime = eat(/\s(?:в\s+)?(\d{1,2})[:.](\d{2})\s/);
  const plainTime = colonTime ? null : eat(/\sв\s+(\d{1,2})\s*(?:ч(?:ас(?:ов|а)?)?)?\s/i);
  const hourOnly = colonTime || plainTime ? null : eat(/\s(\d{1,2})\s*ч\s/i);
  const dayPart = eat(/\s(утра|дня|вечера|ночи)\s/i);
  const timeMatch = colonTime ?? plainTime ?? hourOnly;
  let hour = 12;
  let minute = 0;
  let hasTime = false;
  if (timeMatch) {
    const parsedHour = Number(timeMatch[1]);
    const parsedMinute = colonTime ? Number(colonTime[2]) : 0;
    if (parsedHour >= 0 && parsedHour <= 23 && parsedMinute >= 0 && parsedMinute <= 59) {
      hour = parsedHour;
      minute = parsedMinute;
      hasTime = true;
    }
  }
  if (hasTime && dayPart) {
    const word = dayPart[1].toLowerCase();
    if (word === "вечера" && hour < 12) hour += 12;
    if (word === "дня" && hour < 5) hour += 12;
    if (word === "ночи" && hour === 12) hour = 0;
  }

  /** @type {string | null} */
  let dueAt = null;
  let allDay = false;
  if (day) {
    dueAt = zonedTimeToUtc(day.year, day.month, day.day, hasTime ? hour : 12, hasTime ? minute : 0, timeZone).toISOString();
    allDay = !hasTime;
  } else if (hasTime) {
    const candidate = zonedTimeToUtc(base.year, base.month, base.day, hour, minute, timeZone);
    // Время без даты: если сегодня оно уже прошло, срок уезжает на завтра.
    dueAt = (candidate.getTime() <= now.getTime() ? new Date(candidate.getTime() + 86_400_000) : candidate).toISOString();
  }

  let priority = 1;
  const priorityMatch = eat(/\s!([0-3])\s/);
  if (priorityMatch) priority = Number(priorityMatch[1]);
  else if (eat(/\s(важно|срочно)\s/i)) priority = 3;

  /** @type {string | null} */
  let recurrence = null;
  if (eat(/\s(каждый день|ежедневно|каждое утро)\s/i)) recurrence = "daily";
  else if (eat(/\s(каждую неделю|еженедельно|раз в неделю)\s/i)) recurrence = "weekly";
  else if (eat(/\s(по будням|каждый будний день|по рабочим дням)\s/i)) recurrence = "weekdays";
  else if (eat(/\s(каждый месяц|ежемесячно|раз в месяц)\s/i)) recurrence = "monthly";

  const projectMatch = text.match(/#([\p{L}\p{N}_-]{1,60})/u);
  const project = projectMatch ? projectMatch[1].slice(0, 60) : null;
  if (projectMatch) matched.push(projectMatch[0]);
  const tagMatches = Array.from(text.matchAll(/(?:^|\s)\+([\p{L}\p{N}_-]{1,24})/gu)).map((match) => match[1]);
  tagMatches.forEach((tag) => matched.push(`+${tag}`));
  text = text.replace(/#[\p{L}\p{N}_-]{1,60}/gu, " ").replace(/(?:^|\s)\+[\p{L}\p{N}_-]{1,24}/gu, " ");

  // Напоминания распознаём в конце строки: «… за день за час», чтобы не съесть слова из названия.
  // Напоминания ищем в конце строки: «… за 2 часа за день».
  // Без срока у задачи напоминаний быть не может, поэтому тогда фразы не трогаем.
  /** @type {number[]} */
  const offsets = [];
  const offsetTail = /\sза\s+(\d{1,3})?\s*(минут(?:ы|у)?|мин|час(?:а|ов)?|ч|сут(?:ки|ок)?|недел(?:ю|и|ь)|день|дня|дней|д)\s*[,;]?\s*$/i;
  let offsetMatch;
  while (dueAt !== null && (offsetMatch = text.match(offsetTail)) !== null) {
    const amount = offsetMatch[1] ? Number(offsetMatch[1]) : 1;
    const unit = offsetMatch[2].toLowerCase();
    const minutes = unit.startsWith("мин") ? amount
      : unit.startsWith("ч") ? amount * 60
      : unit.startsWith("недел") ? amount * 10080
      : amount * 1440;
    if (minutes > 0 && minutes <= 20160) offsets.push(minutes);
    matched.push(offsetMatch[0].trim());
    text = text.slice(0, text.length - offsetMatch[0].length);
  }
  const noReminders = Boolean(eat(/\s(без напоминаний|без напоминания|не напоминать|без будильника)\s/i));

  const title = normalizeSpaces(text).replace(/^[-,;:]+/, "").replace(/[-,;:]+$/, "").slice(0, 200);

  return {
    title,
    dueAt,
    allDay: dueAt ? allDay : false,
    priority,
    project,
    tags: Array.from(new Set(tagMatches)).slice(0, 8),
    recurrence,
    offsets: noReminders ? [] : offsets.length > 0 ? Array.from(new Set(offsets)).slice(0, 6) : null,
    matched,
  };
}

/**
 * Перенос задачи: «15м», «1ч», «2д», «завтра 10:00».
 * @param {string} raw @returns {{ kind: "minutes", minutes: number } | { kind: "tomorrow", hour: number, minute: number } | null}
 */
export function parseSnooze(raw) {
  const text = normalizeSpaces(raw).toLowerCase();
  if (!text) return { kind: "minutes", minutes: 15 };
  if (text.startsWith("завтра")) {
    const time = text.match(/(\d{1,2})[:.](\d{2})/);
    return { kind: "tomorrow", hour: time ? Number(time[1]) : 10, minute: time ? Number(time[2]) : 0 };
  }
  if (text === "час" || text === "1 час") return { kind: "minutes", minutes: 60 };
  const match = text.match(/^(\d{1,4})\s*(м|мин|минут\w*|ч|час\w*|д|день|дня|дней)?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] ?? "м";
  const minutes = unit.startsWith("м") ? amount : unit.startsWith("ч") ? amount * 60 : amount * 1440;
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 20160) return null;
  return { kind: "minutes", minutes };
}

/**
 * Приведение remind_offsets к значениям, разрешённым ограничением в БД.
 * @param {unknown} offsets @param {number[]} [fallback] @param {boolean} [allowEmpty] разрешить пустой набор (напоминания выключены)
 * @returns {number[]}
 */
export function normalizeOffsets(offsets, fallback = DEFAULT_OFFSETS, allowEmpty = false) {
  const list = Array.isArray(offsets) ? offsets.map(Number).filter((value) => ALLOWED_OFFSETS.includes(value)) : [];
  const unique = Array.from(new Set(list)).slice(0, 6);
  if (unique.length > 0) return unique;
  return allowEmpty ? [] : fallback;
}
