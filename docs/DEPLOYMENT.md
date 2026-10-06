# Служебное развёртывание Forge Tasks

Файл для владельца проекта: как поднять облако, бота и напоминания. Ключи и токены живут только
в Supabase Secrets/Vault и настройках Telegram. Не помещайте их в приложение, SQL-файлы, GitHub или переписку.

## 1. База данных

Создайте **отдельный** проект Supabase (он не связан с LTT) и примените в SQL Editor:

1. `supabase/migrations/202610060001_tasks_core.sql` — профили, задачи, очередь напоминаний, повторения, привязка Telegram, RLS.

Файл идемпотентен: повторный запуск ничего не ломает. Что он создаёт:

- `profiles` — один профиль на пользователя Auth: часовой пояс, дайджест, роль;
- `tasks` — задачи с дедлайном, набором напоминаний (`remind_offsets`) и повторением;
- `task_reminders` — очередь уведомлений; её наполняет триггер, читает только серверный ключ;
- `telegram_pairing_requests`, `telegram_accounts`, `telegram_input_sessions` — привязка Telegram и состояние диалога бота.

Клиентам разрешены только собственные строки. Роль `owner` не даёт доступа к чужим задачам.

## 2. Auth и Edge Functions

В Authentication включите провайдер **Email/Password** и проверьте отправку письма подтверждения.

Разверните функции из `supabase/functions/`:

- `telegram-bot` — webhook Telegram (команды, кнопки, быстрый ввод);
- `link-telegram` — привязка аккаунта по одноразовому коду из приложения;
- `send-reminders` — доставка напоминаний и утренних дайджестов;
- `_shared/` — общие модули (разбор ввода и время), подтягиваются автоматически.

В Edge Function Secrets задайте:

- `TELEGRAM_BOT_TOKEN` — токен от BotFather;
- `TELEGRAM_WEBHOOK_SECRET` — случайная строка для проверки webhook;
- `OWNER_TELEGRAM_ID` — числовой Telegram ID владельца (команда `/myid` в боте);
- `CRON_SECRET` — отдельная случайная строка для вызова `send-reminders` по расписанию.

Серверный secret key нужен только функциям; в клиент попадает исключительно publishable key.

`notifications`, `backups` и прочие разделы настраивать не нужно. Резервное копирование базы — по желанию владельца.

## 3. Telegram

Установите webhook на URL функции:

`https://<project-ref>.supabase.co/functions/v1/telegram-bot`

Передайте тот же `TELEGRAM_WEBHOOK_SECRET` как Telegram `secret_token`. Не публикуйте полный URL запроса к Bot API: в нём содержится токен бота.

Полезно сразу зарегистрировать список команд (подставьте токен только в своей консоли):

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setMyCommands" -H "Content-Type: application/json" \
  -d '{"commands":[
    {"command":"today","description":"Задачи на сегодня и просроченные"},
    {"command":"week","description":"Ближайшие 7 дней"},
    {"command":"all","description":"Все открытые задачи"},
    {"command":"add","description":"Добавить задачу текстом"},
    {"command":"done","description":"Закрыть задачу по ID"},
    {"command":"snooze","description":"Перенести дедлайн"},
    {"command":"due","description":"Задать срок вручную"},
    {"command":"delete","description":"Удалить задачу"},
    {"command":"digest","description":"Настроить утренний дайджест"},
    {"command":"settings","description":"Часовой пояс и дайджест"},
    {"command":"cancel","description":"Отменить ввод"}
  ]}'
```

Как это работает для пользователя: `/start` выдаёт одноразовый код (действует 10 минут), код вводится в приложении в разделе «Аккаунт». Привязка активируется автоматически. После этого любое текстовое сообщение — это задача:

```
оплатить хостинг завтра 18:30 !2 #работа за день
позвонить врачу в пятницу в 10
отчёт 06.11.2026 09:00 по будням за 2 часа
```

## 4. Расписание напоминаний

Включите расширения `pg_cron`, `pg_net` и Vault. Сохраните `CRON_SECRET` в Vault под именем `forge_tasks_cron_secret`, затем выполните в SQL Editor:

```sql
select cron.schedule(
  'forge-tasks-reminders',
  '* * * * *',
  $$
    select net.http_post(
      url := 'https://<project-ref>.supabase.co/functions/v1/send-reminders',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (
          select decrypted_secret from vault.decrypted_secrets
          where name = 'forge_tasks_cron_secret' limit 1
        )
      ),
      body := '{}'::jsonb
    );
  $$
);
```

Перед повторной установкой удалите старое задание:

```sql
select cron.unschedule(jobid) from cron.job where jobname = 'forge-tasks-reminders';
```

Задание раз в минуту забирает созревшие напоминания (набор `remind_offsets` каждой задачи, плюс мягкая подсказка через 5 минут после дедлайна) и рассылает утренние дайджесты по времени из профиля пользователя. Правка срока или закрытие задачи автоматически отменяет несработавшие уведомления.

## 5. Клиентское приложение

Ключи не вшиты в установщик: их вводят в приложении в разделе **Настройки → Облако и аккаунт**:

- Supabase URL: `https://<project-ref>.supabase.co`
- Publishable key (или legacy anon key): из Settings → API.

Так один установщик годится и для локального режима, и для разных проектов.

## 6. Релиз

Сначала создайте репозиторий (например `ForgeTasks`) и подставьте его в `package.json`:
`build.publish.owner` и `build.publish.repo`. От них зависят автообновление и адрес релизов.
Тег `vX.Y.Z` должен совпадать с `version` в `package.json`. Дальше GitHub Actions (`.github/workflows/release.yml`) на `windows-latest` собирает NSIS-установщик и публикует релиз с `latest.yml` и `.blockmap` — приложение обновляется через `electron-updater`.

```bash
npm version patch
git push --follow-tags
```

Установщик не подписан сертификатом Authenticode: Windows покажет предупреждение SmartScreen. Проверка подписи обновлений в приложении отключена (`verifyUpdateCodeSignature: false`).

## 7. Проверка перед публикацией

1. `npm ci && npm test` — тесты схемы, разбора ввода, слияния данных и планировщика.
2. Привяжите Telegram владельца первым: профиль должен получить роль `owner`, а `/stats` — работать только у него.
3. Проверьте, что два аккаунта видят только свои задачи, а владелец не видит чужие.
4. Заведите задачу с дедлайном через 2 минуты с напоминанием «за 5 минут» — проверьте доставку и что повторных сообщений нет.
5. Настройте дайджест на ближайшее время и убедитесь, что он приходит один раз в сутки.
6. Проверьте синхронизацию между двумя устройствами и оффлайн-правки: задача, изменённая без сети, должна уйти в облако после появления связи.
