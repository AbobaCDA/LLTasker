// link-telegram — принимает одноразовый код, который пользователь ввёл в приложении,
// и привязывает Telegram-аккаунт к профилю Supabase Auth. Разворачивается с verify_jwt = true.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = requiredEnv("SUPABASE_URL");
const adminKey = getSupabaseSecretKey();
const botToken = requiredEnv("TELEGRAM_BOT_TOKEN");
const ownerTelegramId = Deno.env.get("OWNER_TELEGRAM_ID") ?? "";
const admin: SupabaseClient = createClient(supabaseUrl, adminKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

async function hashCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function telegramSendMessage(chatId: string, text: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!response.ok) throw new Error(`Telegram API returned HTTP ${response.status}`);
  const result = await response.json() as { ok?: boolean };
  if (!result.ok) throw new Error("Telegram API rejected the confirmation message");
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse(405, { ok: false, error: "method_not_allowed" });

  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
  if (!token) return jsonResponse(401, { ok: false, error: "missing_token" });

  const { data: userData, error: userError } = await admin.auth.getUser(token);
  const user = userData?.user;
  if (userError || !user) return jsonResponse(401, { ok: false, error: "invalid_token" });

  let code = "";
  try {
    const body = await request.json() as { code?: unknown };
    code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  } catch {
    return jsonResponse(400, { ok: false, error: "invalid_body" });
  }

  if (!/^[A-Z0-9]{4,32}$/.test(code)) {
    return jsonResponse(400, { ok: false, error: "invalid_code_format" });
  }

  const { data, error } = await admin.rpc("consume_telegram_pairing_code", {
    p_code_hash: await hashCode(code),
    p_user_id: user.id,
    p_owner_telegram_id: ownerTelegramId || null,
  });

  if (error) {
    const message = String(error.message ?? "");
    if (message.includes("PAIRING_CODE_INVALID_EXPIRED_OR_NOT_APPROVED")) {
      return jsonResponse(400, { ok: false, error: "code_expired_or_unknown" });
    }
    if (message.includes("TELEGRAM_ACCOUNT_ALREADY_LINKED")) {
      return jsonResponse(409, { ok: false, error: "telegram_already_linked" });
    }
    if (message.includes("ACCOUNT_NOT_AVAILABLE")) {
      return jsonResponse(403, { ok: false, error: "account_not_available" });
    }
    return jsonResponse(500, { ok: false, error: "linking_failed" });
  }

  const linked = Array.isArray(data) ? data[0] : data;
  const chatId = linked?.linked_chat_id ?? linked?.chat_id;
  const username = linked?.linked_telegram_username ?? linked?.telegram_username ?? "";

  if (chatId) {
    try {
      await telegramSendMessage(
        String(chatId),
        `✅ Аккаунт привязан.\nТеперь задачи и напоминания доступны в Telegram.\nОткрой /menu, чтобы посмотреть список.`,
      );
    } catch {
      // Привязка уже состоялась: неудачное подтверждение не должно ломать ответ клиенту.
    }
  }

  return jsonResponse(200, { ok: true, telegram_username: username ?? "" });
});
