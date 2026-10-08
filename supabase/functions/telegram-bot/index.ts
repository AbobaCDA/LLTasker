// telegram-bot — webhook Telegram: привязка аккаунта, список задач, быстрый ввод,
// закрытие/перенос/повтор, ручной ввод даты и /cancel. Секреты — только в Supabase Secrets.
// Разворачивается с verify_jwt = false (Telegram не умеет JWT), защита — TELEGRAM_WEBHOOK_SECRET.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { addLocalDays, formatDue, localDateString } from "../_shared/time.js";
import {
  DEFAULT_OFFSETS,
  RECURRENCE_LABELS,
  normalizeOffsets,
  parseSnooze,
  parseTaskInput,
} from "../_shared/parser.js";

type SnoozeShift = { kind: "minutes"; minutes: number } | { kind: "tomorrow"; hour: number; minute: number };

const supabaseUrl = requiredEnv("SUPABASE_URL");
const botToken = requiredEnv("TELEGRAM_BOT_TOKEN");
const webhookSecret = requiredEnv("TELEGRAM_WEBHOOK_SECRET");
const ownerTelegramId = (Deno.env.get("OWNER_TELEGRAM_ID") ?? "").trim();
const adminKey = getSupabaseSecretKey();
const db: SupabaseClient = createClient(supabaseUrl, adminKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SESSION_TTL_MINUTES = 10;
const PRIORITY_MARKS = ["⚪️", "🔵", "🟠", "🔴"];

type TaskRow = {
  user_id: string;
  id: string;
  title: string;
  notes: string;
  priority: number;
  project: string | null;
  tags: string[];
  due_at: string | null;
  all_day: boolean;
  remind_offsets: number[];
  status: string;
  completed_at: string | null;
  recurrence: string | null;
  series_id: string | null;
  occurrence: number;
  created_at: string;
  updated_at: string;
};

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function getSupabaseSecretKey(): string {
  const keySet = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (keySet) {
    try {
      const parsed = JSON.parse(keySet) as Record<string, string>;
      if (parsed.default) return parsed.default;
      const first = Object.values(parsed)[0];
      if (first) return first;
    } catch {
      // Ниже — запасной вариант для старых проектов.
    }
  }
  const legacyKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (legacyKey) return legacyKey;
  throw new Error("Supabase server secret key is not configured");
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function safeText(value: unknown, limit = 200): string {
  return String(value ?? "").replace(/[<>]/g, "").replace(/[\r\n\t]+/g, " ").trim().slice(0, limit);
}

async function hashCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function makePairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

async function telegram(method: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null) as { ok?: boolean; result?: Record<string, unknown> } | null;
  if (!response.ok || !payload?.ok) return null;
  return payload.result ?? {};
}

function sendMessage(chatId: string, text: string, replyMarkup?: unknown): Promise<Record<string, unknown> | null> {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    parse_mode: undefined,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

function answerCallback(callbackId: string, text?: string): Promise<Record<string, unknown> | null> {
  return telegram("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) });
}

function editMessage(chatId: string, messageId: number, text: string, replyMarkup?: unknown): Promise<Record<string, unknown> | null> {
  return telegram("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

// Часовые пояса и разбор ввода живут в ../_shared: тот же код проверяется тестами.

// --- Очередь напоминаний, которую нужно синхронизировать с ручными правками -----

function taskLine(task: TaskRow, timeZone: string, index?: number): string {
  const mark = PRIORITY_MARKS[Number(task.priority)] ?? "⚪️";
  const due = formatDue(task.due_at, timeZone, task.all_day);
  const project = task.project ? ` · #${task.project}` : "";
  const repeat = task.recurrence ? ` · 🔁 ${RECURRENCE_LABELS[task.recurrence] ?? task.recurrence}` : "";
  const prefix = index === undefined ? "" : `${index}. `;
  return `${prefix}${mark} ${safeText(task.title, 90)} — ${due}${project}${repeat}`;
}

function taskCard(task: TaskRow, timeZone: string): string {
  const lines = [
    `${PRIORITY_MARKS[Number(task.priority)] ?? "⚪️"} ${safeText(task.title, 200)}`,
    `📅 Срок: ${formatDue(task.due_at, timeZone, task.all_day)}`,
  ];
  if (task.project) lines.push(`📁 Проект: #${task.project}`);
  if (task.tags?.length) lines.push(`🏷 Теги: ${task.tags.map((tag) => `+${safeText(tag, 24)}`).join(" ")}`);
  if (task.recurrence) lines.push(`🔁 Повтор: ${RECURRENCE_LABELS[task.recurrence] ?? task.recurrence}`);
  const offsets = (task.remind_offsets ?? []).filter((value) => value > 0).sort((a, b) => b - a);
  lines.push(offsets.length ? `🔔 Напоминания: ${offsets.map((value) => value % 1440 === 0 ? `${value / 1440} д` : value % 60 === 0 ? `${value / 60} ч` : `${value} мин`).join(", ")} до срока` : "🔕 Напоминания выключены");
  if (task.notes) lines.push(`📝 ${safeText(task.notes, 400)}`);
  lines.push(`🆔 ${safeText(task.id, 64)}`);
  return lines.join("\n");
}

function taskKeyboard(task: TaskRow, fromList = false) {
  const repeat: string | null = task.recurrence;
  const cycle: Record<string, string | null> = { daily: "weekly", weekly: "weekdays", weekdays: "monthly", monthly: null };
  const nextRepeat = repeat ? cycle[repeat] ?? "daily" : "daily";
  const repeatLabel = repeat ? `🔁 ${RECURRENCE_LABELS[repeat]}` : "🔁 Повтор: выкл";
  const rows: Array<Array<Record<string, unknown>>> = [
    [
      { text: "✅ Готово", callback_data: `done:${task.id}` },
      { text: "⏰ +15 мин", callback_data: `snooze:15:${task.id}` },
    ],
    [
      { text: "🕐 +1 час", callback_data: `snooze:60:${task.id}` },
      { text: "🗓 Завтра 10:00", callback_data: `snooze:tomorrow:${task.id}` },
    ],
    [
      { text: "✏️ Изменить срок", callback_data: `due:${task.id}` },
      { text: repeatLabel, callback_data: `repeat:${nextRepeat}:${task.id}` },
    ],
    [
      { text: "🔔 Напоминания", callback_data: `remind:${task.id}` },
      { text: "🗑 Удалить", callback_data: `ask_delete:${task.id}` },
    ],
  ];
  rows.push([{ text: fromList ? "⬅️ К меню" : "⬅️ К списку", callback_data: "list:menu" }]);
  return { inline_keyboard: rows };
}

// --- Сессии ручного ввода ------------------------------------------------------

async function setSession(telegramUserId: string, chatId: string, mode: string, taskId: string | null, payload: Record<string, unknown> = {}) {
  await db.from("telegram_input_sessions").upsert({
    telegram_user_id: telegramUserId,
    chat_id: chatId,
    mode,
    task_id: taskId,
    payload,
    expires_at: new Date(Date.now() + SESSION_TTL_MINUTES * 60_000).toISOString(),
  });
}

async function getSession(telegramUserId: string) {
  const { data } = await db.from("telegram_input_sessions").select("*").eq("telegram_user_id", telegramUserId).maybeSingle();
  if (!data) return null;
  if (new Date(String(data.expires_at)).getTime() < Date.now()) {
    await clearSession(telegramUserId);
    return null;
  }
  return data as { mode: string; task_id: string | null; payload: Record<string, unknown> };
}

function clearSession(telegramUserId: string) {
  return db.from("telegram_input_sessions").delete().eq("telegram_user_id", telegramUserId);
}

// --- Данные ----------------------------------------------------------------

async function getAccount(telegramUserId: string) {
  const { data } = await db.from("telegram_accounts").select("user_id, chat_id, telegram_username").eq("telegram_user_id", telegramUserId).maybeSingle();
  return data as { user_id: string; chat_id: string; telegram_username: string | null } | null;
}

async function getProfile(userId: string) {
  const { data } = await db.from("profiles").select("id, timezone, digest_enabled, digest_at, role, access_status").eq("id", userId).maybeSingle();
  return data as { id: string; timezone: string; digest_enabled: boolean; digest_at: string; role: string; access_status: string } | null;
}

async function openTasks(userId: string, filter: "today" | "week" | "all" | "overdue", timeZone: string, limit = 10): Promise<TaskRow[]> {
  const { data } = await db
    .from("tasks")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "open")
    .order("due_at", { ascending: true, nullsFirst: false })
    .limit(400);
  const tasks = (data ?? []) as TaskRow[];
  const today = localDateString(new Date(), timeZone);
  const weekEnd = localDateString(addLocalDays(new Date(), 7, timeZone, 23, 59), timeZone);
  const filtered = tasks.filter((task) => {
    if (!task.due_at) return filter === "all";
    const local = localDateString(new Date(task.due_at), timeZone);
    if (filter === "today") return local <= today;
    if (filter === "overdue") return local < today;
    if (filter === "week") return local <= weekEnd;
    return true;
  });
  return filtered.slice(0, limit);
}

async function findTask(userId: string, taskId: string): Promise<TaskRow | null> {
  const { data } = await db.from("tasks").select("*").eq("user_id", userId).eq("id", taskId).maybeSingle();
  return (data ?? null) as TaskRow | null;
}

async function updateTask(userId: string, taskId: string, patch: Record<string, unknown>) {
  return db.from("tasks").update(patch).eq("user_id", userId).eq("id", taskId).select("*").maybeSingle();
}

async function insertTask(userId: string, task: Partial<TaskRow>) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const { data, error } = await db.from("tasks").insert({
    user_id: userId,
    id,
    title: task.title ?? "Без названия",
    notes: task.notes ?? "",
    priority: task.priority ?? 1,
    project: task.project ?? null,
    tags: task.tags ?? [],
    due_at: task.due_at ?? null,
    all_day: task.all_day ?? false,
    remind_offsets: normalizeOffsets(task.remind_offsets, DEFAULT_OFFSETS, true),
    status: "open",
    recurrence: task.recurrence ?? null,
  }).select("*").maybeSingle();
  if (error) throw new Error(error.message);
  return data as TaskRow;
}

// --- Экраны --------------------------------------------------------------------

async function sendMenu(chatId: string, userId: string, timeZone: string, edit?: { messageId: number }) {
  const tasks = await openTasks(userId, "today", timeZone, 8);
  const overdue = await openTasks(userId, "overdue", timeZone, 99);
  const header = overdue.length > 0
    ? `Меню. На сегодня задач: ${tasks.filter((task) => task.due_at).length}, просрочено: ${overdue.length}`
    : "Меню. Дедлайнов на сегодня нет — можно планировать спокойно.";
  const lines = tasks.length > 0 ? [header, "", ...tasks.map((task, index) => taskLine(task, timeZone, index + 1))] : [header];
  const buttons = tasks.map((task) => [{ text: `${PRIORITY_MARKS[Number(task.priority)] ?? "⚪️"} ${safeText(task.title, 32)}`, callback_data: `task:${task.id}` }]);
  buttons.push([
    { text: "📋 Сегодня", callback_data: "list:today" },
    { text: "🗓 Неделя", callback_data: "list:week" },
  ]);
  buttons.push([
    { text: "➕ Как добавить", callback_data: "help:add" },
    { text: "⚙️ Настройки", callback_data: "settings:open" },
  ]);
  const payload = { inline_keyboard: buttons };
  if (edit) await editMessage(chatId, edit.messageId, lines.join("\n"), payload);
  else await sendMessage(chatId, lines.join("\n"), payload);
}

async function sendTaskList(chatId: string, userId: string, timeZone: string, filter: "today" | "week" | "all", edit?: { messageId: number }) {
  const titles = { today: "📋 Сегодня и просроченное", week: "🗓 Ближайшая неделя", all: "📚 Все открытые задачи" };
  const tasks = await openTasks(userId, filter, timeZone, 12);
  const lines = tasks.length === 0
    ? [`${titles[filter]}\n\nПусто. Добавь задачу командой /add или текстом: «позвонить в банк завтра 12:00».`]
    : [titles[filter], "", ...tasks.map((task, index) => taskLine(task, timeZone, index + 1))];
  const buttons: Array<Array<Record<string, unknown>>> = tasks.map((task) => [
    { text: `${PRIORITY_MARKS[Number(task.priority)] ?? "⚪️"} ${safeText(task.title, 32)}`, callback_data: `task:${task.id}` },
  ]);
  buttons.push([
    { text: "📋 Сегодня", callback_data: "list:today" },
    { text: "🗓 Неделя", callback_data: "list:week" },
    { text: "📚 Все", callback_data: "list:all" },
  ]);
  const payload = { inline_keyboard: buttons };
  if (edit) await editMessage(chatId, edit.messageId, lines.join("\n"), payload);
  else await sendMessage(chatId, lines.join("\n"), payload);
}

const HELP = [
  "LLTasker в Telegram.",
  "",
  "Быстрый ввод — просто отправь текст:",
  "«оплатить хостинг завтра 18:30 !2 #работа за день»",
  "«позвонить врачу в пятницу в 10 важно по будням»",
  "",
  "Команды:",
  "/today — на сегодня и просроченное",
  "/week — ближайшие 7 дней",
  "/all — все открытые задачи",
  "/add текст — добавить задачу",
  "/done ID — закрыть",
  "/snooze ID 15м|1ч|завтра — перенести дедлайн",
  "/due ID текст — задать срок вручную",
  "/delete ID — удалить",
  "/digest 09:00 | off — утренний дайджест",
  "/settings — часовой пояс и дайджест",
  "/cancel — отменить ввод",
].join("\n");

// --- Команды -------------------------------------------------------------------

async function handleCommand(message: Record<string, any>, command: string, args: string[]) {
  const chatId = String(message.chat.id);
  const telegramUserId = String(message.from?.id ?? "");
  const account = await getAccount(telegramUserId);

  if (command === "/myid") {
    await sendMessage(chatId, `Твой Telegram ID: ${telegramUserId}`);
    return;
  }

  if (command === "/start") {
    if (account) {
      const profile = await getProfile(account.user_id);
      if (!profile || profile.access_status !== "active") {
        await sendMessage(chatId, "Аккаунт пока не активирован. Введи код привязки в приложении.");
        return;
      }
      await sendMenu(chatId, profile.id, profile.timezone);
      return;
    }
    const code = makePairingCode();
    await db.from("telegram_pairing_requests").insert({
      telegram_user_id: telegramUserId,
      chat_id: chatId,
      telegram_username: message.from?.username ?? null,
      first_name: safeText(message.from?.first_name, 64),
      code_hash: await hashCode(code),
      expires_at: new Date(Date.now() + SESSION_TTL_MINUTES * 60_000).toISOString(),
    });
    await sendMessage(
      chatId,
      `Код привязки: ${code}\n\nОн действует ${SESSION_TTL_MINUTES} минут.\nОткрой приложение LLTasker → «Аккаунт» → введи этот код. Привязка произойдёт автоматически.`,
    );
    return;
  }

  if (!account) {
    await sendMessage(chatId, "Сначала отправь /start, получи код и введи его в приложении — затем привязка активируется автоматически.");
    return;
  }

  const profile = await getProfile(account.user_id);
  if (!profile || profile.access_status !== "active") {
    await sendMessage(chatId, "Доступ приостановлен. Проверь аккаунт в приложении.");
    return;
  }
  const timeZone = profile.timezone || "Europe/Moscow";
  const userId = profile.id;

  if (command === "/help") {
    await sendMessage(chatId, HELP);
    return;
  }

  if (command === "/menu") {
    await sendMenu(chatId, userId, timeZone);
    return;
  }

  if (command === "/cancel") {
    await clearSession(telegramUserId);
    await sendMessage(chatId, "Ввод отменён.");
    return;
  }

  if (command === "/today") {
    await sendTaskList(chatId, userId, timeZone, "today");
    return;
  }

  if (command === "/week") {
    await sendTaskList(chatId, userId, timeZone, "week");
    return;
  }

  if (command === "/all" || command === "/list") {
    await sendTaskList(chatId, userId, timeZone, "all");
    return;
  }

  if (command === "/add") {
    const text = args.join(" ").trim();
    if (!text) {
      await setSession(telegramUserId, chatId, "add_task", null);
      await sendMessage(chatId, "Отправь задачу одним сообщением.\nНапример: «отчёт за квартал в пятницу 18:00 !3 #работа».\n/cancel — отменить.");
      return;
    }
    await createTaskFromText(chatId, userId, timeZone, text, telegramUserId);
    return;
  }

  if (command === "/done" || command === "/complete") {
    const task = await resolveTask(userId, args[0], timeZone);
    if (!task) {
      await sendMessage(chatId, "Не нашёл задачу. Открой /today и нажми кнопку под нужной задачей.");
      return;
    }
    await completeTask(chatId, userId, timeZone, task);
    return;
  }

  if (command === "/snooze") {
    const task = await resolveTask(userId, args[0], timeZone);
    if (!task) {
      await sendMessage(chatId, "Не нашёл задачу. Открой /today и выбери её кнопкой.");
      return;
    }
    const shift = parseSnooze(args.slice(1).join(" "));
    if (!shift) {
      await sendMessage(chatId, "Укажи перенос: /snooze ID 15м, 1ч, 1д или «завтра 10:00».");
      return;
    }
    await snoozeTask(chatId, userId, timeZone, task, shift);
    return;
  }

  if (command === "/due") {
    const task = await resolveTask(userId, args[0], timeZone);
    if (!task) {
      await sendMessage(chatId, "Не нашёл задачу. Открой /today и выбери её кнопкой.");
      return;
    }
    const text = args.slice(1).join(" ").trim();
    if (!text) {
      await setSession(telegramUserId, chatId, "set_due", task.id);
      await sendMessage(chatId, `Когда напомнить про «${safeText(task.title, 60)}»?\nНапиши: «завтра 12:00», «06.10 19:30», «в пятницу в 10».\n/cancel — отменить.`);
      return;
    }
    await applyManualDue(chatId, userId, timeZone, task, text);
    return;
  }

  if (command === "/delete") {
    const task = await resolveTask(userId, args[0], timeZone);
    if (!task) {
      await sendMessage(chatId, "Не нашёл задачу. Открой /today и выбери её кнопкой.");
      return;
    }
    await db.from("tasks").delete().eq("user_id", userId).eq("id", task.id);
    await sendMessage(chatId, `Удалил: ${safeText(task.title, 80)}`);
    return;
  }

  if (command === "/digest") {
    const value = (args[0] ?? "").toLowerCase();
    if (value === "off" || value === "выкл") {
      await db.from("profiles").update({ digest_enabled: false }).eq("id", userId);
      await sendMessage(chatId, "Утренний дайджест выключен.");
      return;
    }
    if (value === "on" || value === "вкл") {
      await db.from("profiles").update({ digest_enabled: true }).eq("id", userId);
      await sendMessage(chatId, `Дайджест включён. Время: ${String(profile.digest_at).slice(0, 5)} (${timeZone}).`);
      return;
    }
    const match = value.match(/^(\d{1,2})[:.](\d{2})$/);
    if (!match) {
      await sendMessage(chatId, "Формат: /digest 09:00 либо /digest off.");
      return;
    }
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) {
      await sendMessage(chatId, "Такого времени не бывает. Например: /digest 08:30.");
      return;
    }
    await db.from("profiles").update({ digest_enabled: true, digest_at: `${String(hour).padStart(2, "0")}:${minute}:00` }).eq("id", userId);
    await sendMessage(chatId, `Дайджест будет приходить в ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} (${timeZone}).`);
    return;
  }

  if (command === "/settings") {
    await sendMessage(
      chatId,
      [
        "⚙️ Настройки",
        `Часовой пояс: ${timeZone}`,
        `Утренний дайджест: ${profile.digest_enabled ? `включён в ${String(profile.digest_at).slice(0, 5)}` : "выключен"}`,
        "",
        "Часовой пояс меняется в приложении (Аккаунт → Настройки), дайджест — командой /digest 09:00 или /digest off.",
        "Напоминания по умолчанию: за 1 день, за 1 час и за 10 минут до срока.",
      ].join("\n"),
    );
    return;
  }

  if (command === "/stats") {
    const { data, error } = await db.rpc("owner_stats");
    const stats = Array.isArray(data) ? data[0] : data;
    if (error || !stats) {
      await sendMessage(chatId, "Статистика доступна только владельцу.");
      return;
    }
    await sendMessage(
      chatId,
      [
        "📊 Статистика",
        `Профилей: ${stats.users_total}, активных: ${stats.users_active}`,
        `Открытых задач: ${stats.tasks_open}`,
        `Закрыто за 7 дней: ${stats.tasks_done_7d}`,
        `Напоминаний в очереди: ${stats.reminders_pending}`,
      ].join("\n"),
    );
    return;
  }

  await sendMessage(chatId, "Не знаю такой команды. /help — список.");
}

async function resolveTask(userId: string, rawId: string | undefined, timeZone: string): Promise<TaskRow | null> {
  if (!rawId) {
    const tasks = await openTasks(userId, "today", timeZone, 10);
    return tasks.length === 1 ? tasks[0] : null;
  }
  const direct = await findTask(userId, rawId.trim());
  if (direct) return direct;
  const index = Number(rawId.trim());
  if (Number.isInteger(index) && index > 0) {
    const tasks = await openTasks(userId, "today", timeZone, 10);
    return tasks[index - 1] ?? null;
  }
  return null;
}

async function createTaskFromText(chatId: string, userId: string, timeZone: string, text: string, telegramUserId: string) {
  const parsed = parseTaskInput(text, timeZone);
  if (!parsed.title) {
    await sendMessage(chatId, "Не понял название задачи. Напиши текст задачи ещё раз или /cancel.");
    return;
  }
  const task = await insertTask(userId, {
    title: parsed.title,
    due_at: parsed.dueAt,
    all_day: parsed.allDay,
    priority: parsed.priority,
    project: parsed.project,
    tags: parsed.tags,
    recurrence: parsed.recurrence,
    remind_offsets: parsed.offsets === null ? DEFAULT_OFFSETS : parsed.offsets,
  });
  await clearSession(telegramUserId);
  await sendMessage(chatId, `Добавил:\n${taskCard(task, timeZone)}`, taskKeyboard(task));
}

async function completeTask(chatId: string, userId: string, timeZone: string, task: TaskRow) {
  const { data } = await updateTask(userId, task.id, { status: "done" });
  const updated = (data ?? task) as TaskRow;
  const spawned = updated.recurrence
    ? await db.from("tasks").select("*").eq("user_id", userId).eq("series_id", updated.series_id ?? updated.id).eq("occurrence", updated.occurrence + 1).maybeSingle()
    : null;
  const next = spawned?.data as TaskRow | null;
  const lines = [`✅ Готово: ${safeText(task.title, 120)}`];
  if (next) lines.push(`🔁 Следующее вхождение: ${formatDue(next.due_at, timeZone)}`);
  await sendMessage(chatId, lines.join("\n"));
}

async function snoozeTask(chatId: string, userId: string, timeZone: string, task: TaskRow, shift: SnoozeShift) {
  const now = new Date();
  const target = shift.kind === "tomorrow"
    ? addLocalDays(now, 1, timeZone, shift.hour, shift.minute)
    : new Date(now.getTime() + shift.minutes * 60_000);
  // Перенос дедлайна сам гасит старые напоминания и строит новые (триггер в БД).
  const offsets = normalizeOffsets(task.remind_offsets, DEFAULT_OFFSETS, true).filter((value) => value > 0);
  const { data } = await updateTask(userId, task.id, { due_at: target.toISOString(), remind_offsets: offsets });
  const updated = (data ?? task) as TaskRow;
  await sendMessage(
    chatId,
    `⏰ Перенёс «${safeText(task.title, 80)}» на ${formatDue(updated.due_at, timeZone)}.`,
    { inline_keyboard: [[{ text: "✅ Готово", callback_data: `done:${task.id}` }, { text: "🕐 Ещё +1 час", callback_data: `snooze:60:${task.id}` }]] },
  );
}

async function applyManualDue(chatId: string, userId: string, timeZone: string, task: TaskRow, raw: string) {
  const dueAt = parseTaskInput(raw, timeZone).dueAt;
  if (!dueAt) {
    await sendMessage(chatId, "Не разобрал дату. Примеры: «сегодня 18:30», «завтра 10», «06.10 19:30», «2026-10-06 09:00». Или /cancel.");
    return;
  }
  const offsets = normalizeOffsets(task.remind_offsets, DEFAULT_OFFSETS, true).filter((value) => value > 0);
  const { data } = await updateTask(userId, task.id, { due_at: dueAt, remind_offsets: offsets, status: "open" });
  const updated = (data ?? task) as TaskRow;
  await sendMessage(chatId, `📅 Новый срок: ${formatDue(updated.due_at, timeZone)}\n${taskCard(updated, timeZone)}`, taskKeyboard(updated));
}

// --- Callback-кнопки -----------------------------------------------------------

async function handleCallback(callback: Record<string, any>) {
  const chatId = String(callback.message?.chat?.id ?? "");
  const messageId = Number(callback.message?.message_id ?? 0);
  const telegramUserId = String(callback.from?.id ?? "");
  const data = String(callback.data ?? "");
  const [action, ...rest] = data.split(":");

  const account = await getAccount(telegramUserId);
  if (!account) {
    await answerCallback(callback.id, "Сначала /start и привязка в приложении.");
    return;
  }
  const profile = await getProfile(account.user_id);
  if (!profile) {
    await answerCallback(callback.id, "Профиль недоступен.");
    return;
  }
  const timeZone = profile.timezone || "Europe/Moscow";
  const userId = profile.id;

  if (action === "list") {
    const filter = rest[0] === "week" ? "week" : rest[0] === "all" ? "all" : "today";
    await answerCallback(callback.id);
    if (rest[0] === "menu") await sendMenu(chatId, userId, timeZone, { messageId });
    else await sendTaskList(chatId, userId, timeZone, filter, { messageId });
    return;
  }

  if (action === "settings") {
    await answerCallback(callback.id);
    await editMessage(chatId, messageId, [
      "⚙️ Настройки",
      `Часовой пояс: ${timeZone}`,
      `Утренний дайджест: ${profile.digest_enabled ? `включён в ${String(profile.digest_at).slice(0, 5)}` : "выключен"}`,
      "",
      "Дайджест: /digest 09:00 или /digest off",
      "Часовой пояс: в приложении, Аккаунт → Настройки",
    ].join("\n"), { inline_keyboard: [[{ text: "⬅️ К меню", callback_data: "list:menu" }]] });
    return;
  }

  if (action === "help") {
    await answerCallback(callback.id);
    await editMessage(chatId, messageId, `Добавить задачу можно текстом:\n\n«купить фильтр для воды завтра 19:00 !2 #дом»\n\nили командой /add текст.\n\nДальше — кнопки под задачей: готово, перенос, повтор, срок, удаление.`, { inline_keyboard: [[{ text: "⬅️ К меню", callback_data: "list:menu" }]] });
    return;
  }

  const taskId = rest[rest.length - 1] ?? "";
  const task = taskId ? await findTask(userId, taskId) : null;
  if (!task) {
    await answerCallback(callback.id, "Задача уже изменена или удалена.");
    return;
  }

  if (action === "task") {
    await answerCallback(callback.id);
    await editMessage(chatId, messageId, taskCard(task, timeZone), taskKeyboard(task, true));
    return;
  }

  if (action === "done") {
    await answerCallback(callback.id, "Отмечено готовым");
    await completeTask(chatId, userId, timeZone, task);
    await sendMenu(chatId, userId, timeZone);
    return;
  }

  if (action === "snooze") {
    const shift = rest[0] === "tomorrow" ? { kind: "tomorrow" as const, hour: 10, minute: 0 } : { kind: "minutes" as const, minutes: Number(rest[0]) || 15 };
    await answerCallback(callback.id, "Перенёс");
    await snoozeTask(chatId, userId, timeZone, task, shift);
    return;
  }

  if (action === "due") {
    await answerCallback(callback.id, "Напиши новую дату следующим сообщением");
    await setSession(telegramUserId, chatId, "set_due", task.id);
    await sendMessage(chatId, `Когда напомнить про «${safeText(task.title, 60)}»?\nНапиши: «завтра 12:00», «06.10 19:30», «в пятницу в 10».\n/cancel — отменить.`);
    return;
  }

  if (action === "repeat") {
    const next = rest[0] === "null" ? null : rest[0];
    await db.from("tasks").update({ recurrence: next }).eq("user_id", userId).eq("id", task.id);
    await answerCallback(callback.id, next ? `Повтор: ${RECURRENCE_LABELS[next]}` : "Повтор выключен");
    const fresh = await findTask(userId, task.id);
    if (fresh) await editMessage(chatId, messageId, taskCard(fresh, timeZone), taskKeyboard(fresh, true));
    return;
  }

  if (action === "remind") {
    const current = normalizeOffsets(task.remind_offsets, DEFAULT_OFFSETS, true);
    const presets: Record<string, number[]> = {
      standard: [1440, 60, 10],
      short: [60, 10],
      workday: [180, 30],
      none: [],
    };
    const { data } = await updateTask(userId, task.id, { remind_offsets: current.length > 0 ? presets.none : presets.standard });
    await answerCallback(callback.id, (data?.remind_offsets?.length ?? 0) > 0 ? "Напоминания включены" : "Напоминания выключены");
    const fresh = await findTask(userId, task.id);
    if (fresh) await editMessage(chatId, messageId, taskCard(fresh, timeZone), taskKeyboard(fresh, true));
    return;
  }

  if (action === "mute") {
    await updateTask(userId, task.id, { remind_offsets: [] });
    await answerCallback(callback.id, "Больше не напомню");
    await editMessage(chatId, messageId, `🔕 «${safeText(task.title, 80)}» — напоминания выключены.`);
    return;
  }

  if (action === "ask_delete") {
    await answerCallback(callback.id);
    await editMessage(chatId, messageId, `Удалить «${safeText(task.title, 120)}» безвозвратно?`, {
      inline_keyboard: [
        [{ text: "🗑 Да, удалить", callback_data: `delete:${task.id}` }],
        [{ text: "⬅️ Оставить", callback_data: `task:${task.id}` }],
      ],
    });
    return;
  }

  if (action === "delete") {
    await db.from("tasks").delete().eq("user_id", userId).eq("id", task.id);
    await answerCallback(callback.id, "Удалено");
    await editMessage(chatId, messageId, `🗑 Удалил: ${safeText(task.title, 120)}`);
    return;
  }

  await answerCallback(callback.id);
}

// --- Webhook -------------------------------------------------------------------

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const supplied = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!safeEqual(supplied, webhookSecret)) return new Response("Unauthorized", { status: 401 });

  let update: Record<string, any>;
  try {
    update = await request.json() as Record<string, any>;
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  try {
    if (update.callback_query) {
      await handleCallback(update.callback_query);
      return Response.json({ ok: true });
    }

    const message = update.message ?? update.edited_message;
    if (!message?.chat?.id) return Response.json({ ok: true });

    const telegramUserId = String(message.from?.id ?? "");
    const chatId = String(message.chat.id);
    const text = String(message.text ?? "").trim();
    if (!text) {
      await sendMessage(chatId, "Пока понимаю только текст. Команды — /help.");
      return Response.json({ ok: true });
    }

    if (text.startsWith("/")) {
      const [rawCommand, ...args] = text.split(/\s+/);
      const command = rawCommand.split("@")[0].toLowerCase();
      await handleCommand(message, command, args);
      return Response.json({ ok: true });
    }

    const account = await getAccount(telegramUserId);
    if (!account) {
      await sendMessage(chatId, "Сначала /start и ввод кода в приложении.");
      return Response.json({ ok: true });
    }
    const profile = await getProfile(account.user_id);
    if (!profile || profile.access_status !== "active") {
      await sendMessage(chatId, "Доступ приостановлен.");
      return Response.json({ ok: true });
    }
    const timeZone = profile.timezone || "Europe/Moscow";

    const session = await getSession(telegramUserId);
    if (session?.mode === "set_due" && session.task_id) {
      const task = await findTask(profile.id, session.task_id);
      if (task) {
        await applyManualDue(chatId, profile.id, timeZone, task, text);
        await clearSession(telegramUserId);
        return Response.json({ ok: true });
      }
      await clearSession(telegramUserId);
    } else if (session?.mode === "add_task") {
      await createTaskFromText(chatId, profile.id, timeZone, text, telegramUserId);
      return Response.json({ ok: true });
    }

    // Свободный текст — это быстрый ввод задачи.
    await createTaskFromText(chatId, profile.id, timeZone, text, telegramUserId);
    return Response.json({ ok: true });
  } catch (_error) {
    // Никогда не отдаём наружу секреты и внутренние детали.
    return Response.json({ ok: true });
  }
});
