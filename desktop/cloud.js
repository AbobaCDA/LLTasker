// Облако: Supabase Auth + синхронизация задач.
// Ключи берём из настроек приложения (Настройки → Облако), чтобы не пересобирать установщик.
// В приложении используется только publishable key: доступ к строкам ограничен RLS.
import { createClient } from '@supabase/supabase-js';
import { app, safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTH_FILE } from './store.js';
import { collectOutgoing, fromCloudRow, mergeTasks, toCloudRow } from './sync-merge.js';

let client = null;
let clientKey = '';
let lastError = '';
const listeners = new Set();

function authFilePath() {
  return join(app.getPath('userData'), AUTH_FILE);
}

/** Шифрованное хранилище сессии: как в LTT, файл бесполезен без учётной записи Windows. */
function createAuthStorage() {
  const readStore = () => {
    try {
      if (!existsSync(authFilePath())) return {};
      const raw = readFileSync(authFilePath());
      const text = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
      return JSON.parse(text);
    } catch {
      return {};
    }
  };
  const writeStore = (value) => {
    const text = JSON.stringify(value);
    try {
      const payload = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from(text, 'utf8');
      writeFileSync(authFilePath(), payload);
    } catch {
      // Без шифрования приложение всё равно работает: файл остаётся локальным.
    }
  };
  return {
    getItem: async (key) => {
      const store = readStore();
      return typeof store[key] === 'string' ? store[key] : null;
    },
    setItem: async (key, value) => {
      const store = readStore();
      store[key] = value;
      writeStore(store);
    },
    removeItem: async (key) => {
      const store = readStore();
      delete store[key];
      writeStore(store);
    },
  };
}

function emit() {
  for (const listener of listeners) {
    try {
      listener(getStateSync());
    } catch {
      // Подписчик упал — это не повод валить синхронизацию.
    }
  }
}

export function onStatusChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function configure(settings) {
  const url = String(settings?.supabaseUrl ?? '').trim();
  const key = String(settings?.supabaseKey ?? '').trim();
  const identity = `${url}|${key.slice(0, 12)}`;
  if (client && identity === clientKey) return client;
  clientKey = identity;
  client = url && key
    ? createClient(url, key, { auth: { storage: createAuthStorage(), persistSession: true, autoRefreshToken: true } })
    : null;
  return client;
}

export function isConfigured() {
  return Boolean(client);
}

export function getStateSync() {
  return { configured: isConfigured(), signedIn: false, email: '', userId: null, error: lastError };
}

/** Полное состояние для интерфейса. */
export async function getState() {
  if (!client) {
    return {
      configured: false,
      signedIn: false,
      email: '',
      userId: null,
      error: lastError || 'Облако не настроено: укажите Supabase URL и publishable key в настройках.',
    };
  }
  const { data } = await client.auth.getSession();
  const session = data?.session ?? null;
  let profile = null;
  if (session?.user) {
    const { data: profileRow } = await client.from('profiles').select('display_name, access_status, role, timezone, digest_enabled, digest_at').eq('id', session.user.id).maybeSingle();
    profile = profileRow ?? null;
    const { data: link } = await client.from('telegram_accounts').select('telegram_username, linked_at').eq('user_id', session.user.id).maybeSingle();
    if (link) profile = { ...profile, telegram_username: link.telegram_username, telegram_linked_at: link.linked_at };
  }
  return {
    configured: true,
    signedIn: Boolean(session?.user),
    email: session?.user?.email ?? '',
    userId: session?.user?.id ?? null,
    emailConfirmed: Boolean(session?.user?.email_confirmed_at),
    profile,
    error: lastError,
  };
}

export async function signUp(email, password) {
  if (!client) throw new Error('облако не настроено: укажи Supabase URL и Publishable key и нажми «Сохранить параметры облака»');
  lastError = '';
  const { data, error } = await client.auth.signUp({ email: email.trim(), password });
  if (error) {
    lastError = error.message;
    throw new Error(error.message);
  }
  emit();
  return { needsConfirmation: !data.session, email: email.trim() };
}

export async function signIn(email, password) {
  if (!client) throw new Error('облако не настроено: укажи Supabase URL и Publishable key и нажми «Сохранить параметры облака»');
  lastError = '';
  const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
  if (error) {
    lastError = error.message;
    throw new Error(error.message);
  }
  emit();
  return getState();
}

export async function signOut() {
  if (!client) return getState();
  await client.auth.signOut();
  emit();
  return getState();
}

export async function linkTelegram(code) {
  if (!client) throw new Error('облако не настроено: укажи Supabase URL и Publishable key и нажми «Сохранить параметры облака»');
  const { data, error } = await client.functions.invoke('link-telegram', { body: { code: String(code ?? '').trim().toUpperCase() } });
  if (error) throw new Error(error.message || 'Не удалось привязать Telegram');
  if (data && data.ok === false) {
    const messages = {
      code_expired_or_unknown: 'Код не найден или истёк. Отправь в боте /start и получи новый.',
      telegram_already_linked: 'Этот Telegram уже привязан к другому аккаунту.',
      account_not_available: 'Аккаунт недоступен.',
    };
    throw new Error(messages[data.error] ?? 'Не удалось привязать Telegram');
  }
  return data ?? { ok: true };
}

/**
 * Двусторонняя синхронизация.
 * @param {any[]} localTasks локальные задачи
 * @param {{ deletes?: string[], force?: boolean }} [options]
 */
export async function syncTasks(localTasks, options = {}) {
  if (!client) throw new Error('облако не настроено: укажи Supabase URL и Publishable key и нажми «Сохранить параметры облака»');
  const { data } = await client.auth.getSession();
  const session = data?.session ?? null;
  if (!session?.user) throw new Error('Требуется вход в аккаунт');
  const userId = session.user.id;

  const cloudRows = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data: page, error } = await client
      .from('tasks')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    cloudRows.push(...(page ?? []));
    if (!page || page.length < pageSize) break;
    from += pageSize;
  }

  const cloudTasks = cloudRows.map(fromCloudRow);
  const result = mergeTasks(localTasks, cloudTasks, { queuedDeletes: options.deletes ?? [], queuedUpserts: options.upsertIds ?? [] });

  // Что отправляем наверх: всё, что помечено dirty/не синхронизировано.
  const outgoing = collectOutgoing(result.tasks).upserts.filter((task) => !options.skipped?.includes(task.id));
  if (outgoing.length > 0) {
    const rows = outgoing.map((task) => toCloudRow(task, userId));
    const { error } = await client.from('tasks').upsert(rows, { onConflict: 'user_id,id' });
    if (error) throw new Error(error.message);
    for (const task of outgoing) {
      task.dirty = false;
      task.synced = true;
    }
  }

  if ((options.deletes ?? []).length > 0) {
    const { error } = await client.from('tasks').delete().eq('user_id', userId).in('id', options.deletes);
    if (error) throw new Error(error.message);
  }

  return {
    tasks: result.tasks.map((task) => ({ ...task, dirty: false })),
    pushed: outgoing.length,
    deleted: (options.deletes ?? []).length,
    removedLocally: result.removedLocally,
    pulled: cloudTasks.length,
    syncedAt: new Date().toISOString(),
  };
}

/** Настройки профиля в облаке (часовой пояс, дайджест). */
export async function pushProfileSettings(settings) {
  if (!client) throw new Error('облако не настроено: укажи Supabase URL и Publishable key и нажми «Сохранить параметры облака»');
  const { data } = await client.auth.getSession();
  const userId = data?.session?.user?.id;
  if (!userId) throw new Error('Требуется вход в аккаунт');
  const { error } = await client
    .from('profiles')
    .update({ timezone: settings.timezone, digest_enabled: settings.digestEnabled, digest_at: settings.digestAt })
    .eq('id', userId);
  if (error) throw new Error(error.message);
  return true;
}
