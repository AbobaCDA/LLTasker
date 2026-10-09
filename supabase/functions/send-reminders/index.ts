// send-reminders — вызывается по расписанию (pg_cron раз в минуту).
// Забирает созревшие напоминания и утренние дайджесты, отправляет их в Telegram.
// Разворачивается с verify_jwt = false: доступ защищён заголовком x-cron-secret.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = requiredEnv("SUPABASE_URL");
const botToken = requiredEnv("TELEGRAM_BOT_TOKEN");
const cronSecret = requiredEnv("CRON_SECRET");
const adminKey = getSupabaseSecretKey();
const db: SupabaseClient = createClient(supabaseUrl, adminKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PRIORITY_MARKS = ["⚪️", "⚪️", "🟠", "🔴"];
const DIGEST_MAX_TASKS = 12;

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
      const first = Object.values(parsed)[1] ?? Object.values(parsed)[0];
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

function sanitize(value: unknown, limit = 200): string {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, limit);
}

function formatMoment(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).format(new Date(iso));
}

function humanOffset(minutes: number): string {
  const value = Number(minutes);
  if (value <= 0) return "срок истёк";
  if (value % 1440 === 0) {
    const days = value / 1440;
    return days === 1 ? "остался 1 день" : `осталось ${days} дн.`;
  }
  if (value % 60 === 0) return `осталось ${value / 60} ч.`;
  if (value > 60) return `осталось ${Math.floor(value / 60)} ч. ${value % 60} мин.`;
  return `осталось ${value} мин.`;
}

async function telegram(method: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Telegram API returned HTTP ${response.status}`);
  const result = await response.json() as { ok?: boolean; description?: string };
  if (!result.ok) throw new Error(result.description ?? "Telegram API rejected the request");
}

function reminderKeyboard(taskId: string, kind: string) {
  const rows: Array<Array<Record<string, unknown>>> = [
    [
      { text: "✅ Готово", callback_data: `done:${taskId}` },
      { text: "⏰ +15 мин", callback_data: `snooze:15:${taskId}` },
    ],
    [
      { text: "🕐 +1 час", callback_data: `snooze:60:${taskId}` },
      { text: "🗓 Завтра 10:00", callback_data: `snooze:tomorrow:${taskId}` },
    ],
  ];
  if (kind === "overdue") {
    rows.unshift([{ text: "🔕 Больше не напоминать", callback_data: `mute:${taskId}` }]);
  }
  return { inline_keyboard: rows };
}

async function markReminder(jobId: string, patch: Record<string, unknown>): Promise<void> {
  await db.from("task_reminders").update({ ...patch, lease_until: null }).eq("id", jobId).eq("status", "sending");
}

async function handleReminder(job: Record<string, unknown>): Promise<"sent" | "cancelled" | "deferred"> {
  const userId = String(job.user_id);
  const taskId = String(job.task_id);

  const { data: task, error: taskError } = await db
    .from("tasks")
    .select("title,status,due_at,priority,remind_offsets,all_day,project")
    .eq("user_id", userId)
    .eq("id", taskId)
    .maybeSingle();

  if (taskError) {
    await markReminder(String(job.job_id), {
      status: "pending",
      next_attempt_at: new Date(Date.now() + 2 * 60_000).toISOString(),
      last_error: "Temporary database lookup error",
    });
    return "deferred";
  }

  const dueAt = task?.due_at ? new Date(String(task.due_at)).getTime() : null;
  const snapshotAt = job.due_at ? new Date(String(job.due_at)).getTime() : null;
  const stillValid = Boolean(task) && task?.status === "open" && dueAt !== null && snapshotAt !== null && Math.abs(dueAt - snapshotAt) < 1000;

  if (!stillValid) {
    await markReminder(String(job.job_id), { status: "cancelled" });
    return "cancelled";
  }

  const kind = String(job.kind);
  const title = sanitize(task?.title, 120);
  const mark = PRIORITY_MARKS[Number(task?.priority ?? 1)] ?? "⚪️";
  const when = formatMoment(String(task?.due_at), "Europe/Moscow");
  const project = task?.project ? ` · ${sanitize(task.project, 40)}` : "";
  const header = kind === "overdue" ? "⏳ Дедлайн уже прошёл" : `⏰ Напоминание: ${humanOffset(Number(job.offset_minutes))}`;
  const text = `${header}\n${mark} ${title}\n📅 ${when} (Москва)${project}`;

  try {
    await telegram("sendMessage", {
      chat_id: String(job.telegram_chat_id),
      text,
      disable_web_page_preview: true,
      reply_markup: reminderKeyboard(String(job.task_id), kind),
    });
    await markReminder(String(job.job_id), { status: "sent", sent_at: new Date().toISOString(), last_error: null });
    return "sent";
  } catch (error) {
    const attempts = Number(job.attempts ?? 1);
    const terminal = attempts >= 5;
    const retryDelayMinutes = Math.min(30, 2 ** Math.max(1, attempts));
    await markReminder(String(job.job_id), {
      status: terminal ? "failed" : "pending",
      next_attempt_at: new Date(Date.now() + retryDelayMinutes * 60_000).toISOString(),
      last_error: terminal
        ? `Доставка не удалась после 5 попыток: ${sanitize((error as Error)?.message, 120)}`
        : "Временная ошибка доставки",
    });
    return "deferred";
  }
}

async function handleDigest(job: Record<string, unknown>): Promise<"sent" | "deferred"> {
  const userId = String(job.user_id);
  const timeZone = String(job.timezone ?? "Europe/Moscow");

  const { data: tasks, error } = await db
    .from("tasks")
    .select("id,title,due_at,priority,project,status")
    .eq("user_id", userId)
    .eq("status", "open")
    .not("due_at", "is", null)
    .order("due_at", { ascending: true })
    .limit(DIGEST_MAX_TASKS + 1);

  if (error) {
    await markDigestRetry(userId);
    return "deferred";
  }

  const localToday = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const today: string[] = [];
  const overdue: string[] = [];

  for (const task of tasks ?? []) {
    const localDate = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(String(task.due_at)));
    const line = `${PRIORITY_MARKS[Number(task.priority ?? 1)] ?? "⚪️"} ${sanitize(task.title, 80)} — ${new Intl.DateTimeFormat("ru-RU", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(String(task.due_at)))}`;
    if (localDate < localToday) overdue.push(line);
    else if (localDate === localToday) today.push(line);
  }

  if (today.length === 0 && overdue.length === 0) {
    await markDigestSent(userId);
    return "sent";
  }

  const parts: string[] = [`☀️ Задачи на сегодня, ${new Intl.DateTimeFormat("ru-RU", { timeZone, day: "numeric", month: "long" }).format(new Date())}`];
  if (overdue.length > 0) parts.push(`\n🔴 Просрочено (${overdue.length}):\n${overdue.join("\n")}`);
  if (today.length > 0) parts.push(`\n📌 На сегодня (${today.length}):\n${today.join("\n")}`);
  if ((tasks?.length ?? 0) > DIGEST_MAX_TASKS) parts.push(`\n…и ещё задачи: отправь /today`);

  try {
    await telegram("sendMessage", {
      chat_id: String(job.telegram_chat_id),
      text: parts.join("\n"),
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: "📋 Открыть список", callback_data: "list:today" }]] },
    });
    await markDigestSent(userId);
    return "sent";
  } catch {
    await markDigestRetry(userId);
    return "deferred";
  }
}

async function markDigestSent(userId: string): Promise<void> {
  await db.from("profiles").update({
    digest_last_sent_at: new Date().toISOString(),
    digest_attempts: 0,
    digest_next_attempt_at: new Date().toISOString(),
  }).eq("id", userId);
}

// Не более пяти попыток за день: иначе дайджест помечается отправленным до завтра.
async function markDigestRetry(userId: string): Promise<void> {
  const { data } = await db.from("profiles").select("digest_attempts").eq("id", userId).maybeSingle();
  const attempts = Number(data?.digest_attempts ?? 1);
  const giveUp = attempts >= 5;
  await db.from("profiles").update({
    digest_attempts: giveUp ? 0 : attempts,
    digest_last_sent_at: giveUp ? new Date().toISOString() : null,
    digest_next_attempt_at: new Date(Date.now() + (giveUp ? 0 : 5 * 60_000)).toISOString(),
  }).eq("id", userId);
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const suppliedSecret = request.headers.get("x-cron-secret") ?? "";
  if (!safeEqual(suppliedSecret, cronSecret)) return new Response("Unauthorized", { status: 401 });

  const summary = { reminders: { claimed: 0, sent: 0, cancelled: 0, deferred: 0 }, digests: { claimed: 0, sent: 0, deferred: 0 } };

  try {
    const { data: jobs, error } = await db.rpc("claim_due_task_reminders", { p_limit: 100 });
    if (error) throw new Error("Could not claim reminders");
    summary.reminders.claimed = jobs?.length ?? 0;
    for (const job of jobs ?? []) {
      const result = await handleReminder(job as Record<string, unknown>);
      summary.reminders[result] += 1;
    }
  } catch {
    return Response.json({ ok: false, error: "reminder_processing_failed", summary }, { status: 500 });
  }

  try {
    const { data: digests, error } = await db.rpc("claim_due_digests", { p_limit: 50 });
    if (error) throw new Error("Could not claim digests");
    summary.digests.claimed = digests?.length ?? 0;
    for (const job of digests ?? []) {
      const result = await handleDigest(job as Record<string, unknown>);
      summary.digests[result] += 1;
    }
  } catch {
    return Response.json({ ok: false, error: "digest_processing_failed", summary }, { status: 500 });
  }

  return Response.json({ ok: true, summary });
});
