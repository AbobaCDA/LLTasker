// Работа со временем и часовыми поясами без внешних зависимостей.
// Одинаково используется ботом (Deno), приложением (Electron) и тестами (Node).

/**
 * @typedef {{ year: number, month: number, day: number, hour: number, minute: number }} ZonedParts
 */

/** @param {Date} date @param {string} timeZone @returns {ZonedParts} */
export function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(date);
  const value = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour") % 24, minute: value("minute") };
}

/** Смещение пояса в минутах для конкретного момента. @param {Date} date @param {string} timeZone @returns {number} */
export function zoneOffsetMinutes(date, timeZone) {
  const { year, month, day, hour, minute } = zonedParts(date, timeZone);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/** Локальные дата и время → момент UTC (смещение считается дважды из-за переходов времени).
 * @param {number} year @param {number} month @param {number} day @param {number} hour @param {number} minute
 * @param {string} timeZone @returns {Date} */
export function zonedTimeToUtc(year, month, day, hour, minute, timeZone) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const offset = zoneOffsetMinutes(guess, timeZone);
  const firstTry = new Date(guess.getTime() - offset * 60_000);
  const secondOffset = zoneOffsetMinutes(firstTry, timeZone);
  return secondOffset === offset ? firstTry : new Date(guess.getTime() - secondOffset * 60_000);
}

/** @param {Date} date @param {string} timeZone @returns {string} «YYYY-MM-DD» в поясе пользователя */
export function localDateString(date, timeZone) {
  const { year, month, day } = zonedParts(date, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Локальная дата + N дней с сохранением указанного локального времени.
 * @param {Date} date @param {number} days @param {string} timeZone @param {number} hour @param {number} minute
 * @returns {Date} */
export function addLocalDays(date, days, timeZone, hour, minute) {
  const { year, month, day } = zonedParts(date, timeZone);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return zonedTimeToUtc(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), hour, minute, timeZone);
}

/** @param {string} iso @param {string} timeZone @returns {string} */
export function localTimeString(iso, timeZone) {
  return new Intl.DateTimeFormat("ru-RU", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

/** Человеческое представление срока: «сегодня 18:30», «завтра», «06.10 19:30».
 * @param {string | null} iso @param {string} timeZone @param {boolean} [allDay] @returns {string} */
export function formatDue(iso, timeZone, allDay = false) {
  if (!iso) return "без срока";
  const date = new Date(iso);
  const today = localDateString(new Date(), timeZone);
  const target = localDateString(date, timeZone);
  const tomorrow = localDateString(addLocalDays(new Date(), 1, timeZone, 12, 0), timeZone);
  const label = target === today
    ? "сегодня"
    : target === tomorrow
      ? "завтра"
      : new Intl.DateTimeFormat("ru-RU", { timeZone, day: "2-digit", month: "2-digit" }).format(date);
  return allDay ? label : `${label} ${localTimeString(iso, timeZone)}`;
}

/** @param {number} minutes @returns {string} */
export function humanOffset(minutes) {
  const value = Number(minutes);
  if (value <= 0) return "срок истёк";
  if (value % 1440 === 0) {
    const days = value / 1440;
    return days === 1 ? "остался 1 день" : `осталось ${days} дн.`;
  }
  if (value % 60 === 0) return `осталось ${value / 60} ч.`;
  return `осталось ${value} мин.`;
}
