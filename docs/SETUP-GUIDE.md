# Forge Tasks — настройка по шагам

Инструкция для владельца проекта: поднять репозиторий, Supabase и Telegram-бота. Делается один раз,
занимает примерно 30–40 минут. После этого приложение работает с облаком и напоминаниями.

Порядок такой: **Гит → Supabase → Бот → приложение → проверки**. Части 2 и 3 связаны одним токеном,
поэтому в части 0 есть короткий шаг «создать бота» — это две минуты, зато дальше всё идёт по порядку.

Везде, где нужны ключи и токены, используйте менеджер паролей. Не вставляйте их в код, в репозиторий,
в переписку и в installer.

---

## Часть 0. Что подготовить

- [ ] **0.1.** Аккаунты: GitHub, Supabase, Telegram. Node.js LTS — с [nodejs.org](https://nodejs.org) (нужен для локального запуска и сборки).
- [ ] **0.2.** Скачайте архив проекта `forge-tasks.zip` из воркспейса и распакуйте, например в `C:\dev\forge-tasks`.
- [ ] **0.3.** Проверьте, что внутри есть `package.json`, `desktop/`, `supabase/`, `task-manager.html`, `docs/`, `tests/`. Папки `node_modules` в архиве нет — это нормально.
- [ ] **0.4.** **Создайте бота** (2 минуты): в Telegram напишите [@BotFather](https://t.me/BotFather) → `/newbot` → имя (например `Forge Tasks`) → username, заканчивающийся на `bot` (например `forge_tasks_bot`). BotFather выдаст токен вида `8012345678:AAH...` — сохраните его как `TELEGRAM_BOT_TOKEN`. Никому не пересылайте: по нему можно управлять ботом.
- [ ] **0.5.** Там же у BotFather (по желанию): `/setdescription` — описание, `/setuserpic` — аватарка. Список команд поставим позже, когда узнаем URL функции.

---

## Часть 1. Гит: репозиторий и код

Проект из воркспейса нужно превратить в репозиторий, из которого потом собирается `.exe`.

- [ ] **1.1.** Создайте репозиторий: GitHub → **New repository** → имя `ForgeTasks` → **Public** → без README и .gitignore (они уже есть в проекте).
  Почему public: автообновление в приложении скачивает релиз анонимно. С приватным репозиторием обновления не заработают без токена внутри приложения.
- [ ] **1.2.** Откройте PowerShell в папке проекта и инициализируйте репозиторий:

```powershell
cd C:\dev\forge-tasks
git init
git add .
git commit -m "Forge Tasks: каркас таск-трекера"
git branch -M main
git remote add origin https://github.com/ВАШ_ЛОГИН/ForgeTasks.git
git push -u origin main
```

- [ ] **1.3.** Проверьте на GitHub, что код на месте. Вкладка **Actions** должна показать workflow «Build and publish Windows release» — он пока не запускается, это правильно: сборка идёт по тегу.
- [ ] **1.4.** Подставьте свой репозиторий в `package.json`, иначе автообновление будет искать релизы не там. В разделе `build.publish` замените логин:

```json
"publish": [
  { "provider": "github", "owner": "ВАШ_ЛОГИН", "repo": "ForgeTasks", "releaseType": "release" }
]
```

Коммит и пуш:

```powershell
git add package.json
git commit -m "Указываю свой репозиторий для обновлений"
git push
```

- [ ] **1.5.** Выпустите первую версию: тег должен точно совпадать с `version` в `package.json` (`0.1.0` → `v0.1.0`):

```powershell
git tag v0.1.0
git push origin v0.1.0
```

- [ ] **1.6.** Дождитесь сборки (5–10 минут, вкладка **Actions** → клик по запуску → логи). В конце в разделе **Releases** появится `Forge-Tasks-Setup-0.1.0.exe` и файлы `latest.yml`, `.blockmap` — по ним работает автообновление.

**Проверка части 1:** в Releases лежит `Forge-Tasks-Setup-0.1.0.exe`. Пока без Supabase приложение запустится и будет работать локально — это нормальный промежуточный результат.

> Дальше версии выпускаются так: `npm version patch` → `git push --follow-tags` → подождать сборку. Если тег не совпадёт с версией, workflow упадёт с явной ошибкой.

---

## Часть 2. Supabase: база, функции, расписание

### 2.A Проект и схема

- [ ] **2.1.** На [supabase.com](https://supabase.com) → **New project**. Имя `forge-tasks`, регион ближе к вам (для РФ удобно Frankfurt / eu-central-1). Пароль базы сохраните в менеджер паролей — он больше нигде не понадобится, но пусть будет.
- [ ] **2.2.** Дождитесь «Project is ready» (1–2 минуты). Скопируйте **Project ref**: **Project Settings → General → Reference ID** (выглядит как `abcdwxyzabcdwxyz`). Он входит в адрес функции: `https://<ref>.supabase.co/functions/v1/...`.
- [ ] **2.3.** Примените схему: **SQL Editor → New query** → откройте файл `supabase/migrations/202610060001_tasks_core.sql` из проекта, скопируйте его целиком, вставьте и нажмите **Run**. Должно быть «Success. No rows returned».
- [ ] **2.4.** Проверьте схему: откройте `supabase/verify.sql`, выполните оттуда **блок 1** — все значения должны быть `true`, триггеров на `tasks` — пять.

> Файл миграции можно запускать повторно: он написан идемпотентно. Если что-то пошло не так — просто запустите ещё раз.

### 2.B Вход и ключи

- [ ] **2.5.** Настройте вход по e-mail: **Authentication → Providers → Email** — провайдер включён, «Confirm email» по умолчанию включён.
  Для личного трекера подтверждение письмом часто мешает: бесплатный SMTP Supabase режет отправку (несколько писем в час), и вы упрётесь в лимит. Решение: либо оставьте подтверждение, либо отключите «Confirm email» — тогда после регистрации вход произойдёт сразу.
- [ ] **2.6.** Скопируйте **publishable key**: **Project Settings → API Keys → Publishable key** (`sb_publishable_...`). Он нужен приложению. Если видите только legacy-ключи — возьмите `anon` из раздела Legacy API keys, он тоже подходит.
  **Secret key (и старый `service_role`) в приложение не попадают никогда** — он нужен только Edge Functions.

### 2.C Edge Functions

- [ ] **2.7.** Секреты функций: **Project Settings → Edge Functions → Secrets** (в некоторых версиях интерфейса — **Edge Functions → Secrets**) → **Add new secret**. Добавьте три:

| Имя | Значение |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | токен из шага 0.4 |
| `TELEGRAM_WEBHOOK_SECRET` | случайная строка, 32+ символа (см. генератор ниже) |
| `CRON_SECRET` | **другая** случайная строка |

`OWNER_TELEGRAM_ID` добавим в части 3 — он станет известен только после запуска бота. Значения `SUPABASE_URL` и серверный ключ подставляются платформой автоматически.

Случайная строка в PowerShell:

```powershell
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
```

- [ ] **2.8.** Поставьте Supabase CLI. Глобальная установка `npm install -g supabase` больше не поддерживается. Два рабочих варианта:

```powershell
# Вариант А (проще): CLI как dev-зависимость проекта, запуск через npx. Нужен Node.js 20+.
cd C:\dev\forge-tasks
npm install supabase --save-dev
npx supabase --version
```

```powershell
# Вариант Б: системная установка через scoop — команда supabase будет доступна везде
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
iwr -useb get.scoop.sh | iex
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase
supabase --version
```

Дальше в инструкции команды записаны как `supabase ...`. Если выбрали вариант А — подставляйте `npx supabase ...`.

- [ ] **2.9.** Войдите в CLI и привяжите проект (команды выполняются в папке `C:\dev\forge-tasks`, где лежит `supabase/config.toml`):

```powershell
supabase login
supabase link --project-ref ВАШ_PROJECT_REF
```

`supabase login` откроет браузер и запросит персональный токен с [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) — создайте и вставьте.

- [ ] **2.10.** Разверните все три функции одной командой:

```powershell
supabase functions deploy
```

Файл `supabase/config.toml` уже описывает, что `telegram-bot` и `send-reminders` работают без JWT (их вызывает Telegram и cron), а `link-telegram` требует JWT пользователя. Отдельные функции можно деплоить поимённо: `supabase functions deploy telegram-bot`.

- [ ] **2.11.** Проверьте, что функции живые: **Edge Functions** в дашборде — три функции со свежей датой деплоя; в логах — сразу после развёртывания, при первом вызове, появятся записи.

### 2.D Расписание напоминаний

- [ ] **2.12.** Включите расширения: **Database → Extensions** → найдите и включите `pg_cron`, `pg_net`. Vault обычно уже включён; если нет — включите и его.
- [ ] **2.13.** Положите `CRON_SECRET` в Vault: **SQL Editor → New query** (подставьте своё значение вместо `<CRON_SECRET>` и свой project-ref):

```sql
select vault.create_secret('<CRON_SECRET>', 'forge_tasks_cron_secret', 'секрет для задания pg_cron');
```

- [ ] **2.14.** Создайте задание «раз в минуту»: тот же SQL Editor, подставьте свой project-ref:

```sql
select cron.schedule(
  'forge-tasks-reminders',
  '* * * * *',
  $$
    select net.http_post(
      url := 'https://ВАШ_PROJECT_REF.supabase.co/functions/v1/send-reminders',
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

Если SQL неудобен, то же самое делается мышкой: **Integrations → Cron → Create job** → тип «Edge Function»/HTTP → функция `send-reminders`, метод `POST`, расписание `* * * * *`, и заголовок `x-cron-secret` = ваш секрет (если в интерфейсе нет поля для заголовка — используйте SQL выше).

- [ ] **2.15.** Проверьте расписание: через 2–3 минуты выполните **блок 6** из `supabase/verify.sql`. Ожидается `status = succeeded` и ответ `{"ok":true,...}` каждую минуту. Если `failed` — смотрите `return_message`: чаще всего не совпадает `CRON_SECRET` в Vault и в Edge Secrets.

> Задание можно ставить повторно: сначала удалите старое — `select cron.unschedule(jobid) from cron.job where jobname = 'forge-tasks-reminders';`

---

## Часть 3. Telegram: webhook, владелец, команды

- [ ] **3.1.** Поставьте webhook. В PowerShell подставьте токен бота, свой project-ref и то же значение `TELEGRAM_WEBHOOK_SECRET`, что лежит в Edge Secrets:

```powershell
$token  = "ТОКЕН_ИЗ_BOTFATHER"
$secret = "ВАШ_TELEGRAM_WEBHOOK_SECRET"
$url    = "https://ВАШ_PROJECT_REF.supabase.co/functions/v1/telegram-bot"

Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$token/setWebhook" `
  -ContentType "application/json" `
  -Body (@{ url = $url; secret_token = $secret; allowed_updates = @('message','callback_query') } | ConvertTo-Json)
```

- [ ] **3.2.** Проверьте webhook:

```powershell
Invoke-RestMethod "https://api.telegram.org/bot$token/getWebhookInfo" | ConvertTo-Json -Depth 4
```

Ожидаемо: `url` = адрес функции, `pending_update_count` = 0, `last_error_message` отсутствует. Если есть ошибка — обычно это несовпадение `secret_token` (тогда Telegram получает 401 и пишет про него в `last_error_message`).

- [ ] **3.3.** Напишите боту `/myid` — он ответит числовым ID. Это ваш Telegram ID.
- [ ] **3.4.** Добавьте его в Edge Secrets под именем `OWNER_TELEGRAM_ID` (значение — только цифры, без @ и кавычек). Передеплой не нужен: функции читают секреты при следующем вызове.
- [ ] **3.5.** Поставьте список команд. Подставьте токен и project-ref:

```powershell
$body = @{
  commands = @(
    @{ command = 'today';    description = 'Задачи на сегодня и просроченные' }
    @{ command = 'week';     description = 'Ближайшие 7 дней' }
    @{ command = 'all';      description = 'Все открытые задачи' }
    @{ command = 'add';      description = 'Добавить задачу текстом' }
    @{ command = 'done';     description = 'Закрыть задачу по ID' }
    @{ command = 'snooze';   description = 'Перенести дедлайн' }
    @{ command = 'due';      description = 'Задать срок вручную' }
    @{ command = 'delete';   description = 'Удалить задачу' }
    @{ command = 'digest';   description = 'Утренний дайджест: время или off' }
    @{ command = 'settings'; description = 'Часовой пояс и дайджест' }
    @{ command = 'cancel';   description = 'Отменить ввод' }
  )
} | ConvertTo-Json -Depth 4

Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$token/setMyCommands" `
  -ContentType "application/json; charset=utf-8" `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
```

- [ ] **3.6.** Проверка: `/start` в боте должен ответить кодом привязки из 10 символов и подсказкой ввести его в приложении. Пока аккаунт не привязан, остальные команды ответят «Сначала отправь /start…».

> Команда `/stats` (сводка по проекту) работает только у владельца — то есть у аккаунта, чей Telegram ID указан в `OWNER_TELEGRAM_ID`.

---

## Часть 4. Приложение

- [ ] **4.1.** Установите `Forge-Tasks-Setup-0.1.0.exe` из Releases. SmartScreen предупредит (установщик не подписан сертификатом) — «Подробнее» → «Выполнить в любом случае». Для разработки можно запускать из папки проекта: `npm ci` → `npm start`.
- [ ] **4.2.** Откройте **Настройки и аккаунт → Облако и аккаунт** и вставьте `Supabase URL` (`https://<ref>.supabase.co`) и `publishable key` из шага 2.6 → **Сохранить параметры облака**.
- [ ] **4.3.** Зарегистрируйтесь: e-mail и пароль (минимум 6 символов) → **Создать аккаунт**. Если подтверждение включено — откройте письмо и перейдите по ссылке.
- [ ] **4.4.** Привяжите Telegram: в боте `/start` → получите код → в приложении введите его в поле «Код привязки Telegram» → **Привязать Telegram**. В бот придёт подтверждение «Аккаунт привязан».
  Этот шаг не только для напоминаний: он активирует профиль (`access_status = active`), без которого база не даёт записывать задачи.
- [ ] **4.5.** Проверьте синхронизацию: добавьте задачу строкой сверху (например `проверить синхронизацию завтра 12:00`) → нажмите **Синхронизировать**. В Supabase → **Table Editor → tasks** должна появиться строка. В боте `/today` покажет ту же задачу.
- [ ] **4.6.** Проверьте напоминания Windows: создайте задачу со сроком через 3 минуты и напоминанием «за 5 мин» (строка вида `тест напоминания в 14:35 за 5 минут`). Свернуть окно в трей — уведомление должно всплыть в назначенную минуту.
- [ ] **4.7.** Проверьте напоминания Telegram: создайте задачу со сроком через 3 минуты. Сообщение придёт в течение минуты после наступления момента — и только одно.
- [ ] **4.8.** Проверьте дайджест: в боте `/digest 12:30` (ближайшее время) и задача на сегодня → в указанную минуту придёт сводка «Задачи на сегодня». Отключается командой `/digest off`.
- [ ] **4.9.** Включите **Запускать с Windows** и закройте окно крестиком — приложение останется в трее, напоминания продолжат работать. Выход — через меню значка в трее.

---

## Часть 5. Приёмочный чек-лист

| Проверка | Ожидаемо |
| --- | --- |
| `verify.sql`, блок 1 | все `true`, триггеров 5, RLS включён |
| `verify.sql`, блок 5 | задание `forge-tasks-reminders`, `* * * * *`, active |
| `verify.sql`, блок 6 | каждую минуту `succeeded` и `{"ok":true,…}` |
| `/start` в боте | код из 10 символов |
| Код введён в приложении | в боте подтверждение, профиль активен |
| Задача из приложения | появляется в Table Editor и в `/today` |
| Задача из бота | появляется в приложении после синхронизации (в течение минуты) |
| Смена дедлайна | старая очередь напоминаний отменена, новая построена |
| Закрытие задачи | напоминания исчезли, у повторяющейся появилось следующее вхождение |
| Два устройства | правки сходятся, ничего не теряется |
| Задача, закрытая в боте | пропадает из списка в приложении |

---

## Часть 6. Если что-то не работает

| Симптом | Причина и что делать |
| --- | --- |
| В приложении «Локальный режим» | не заполнены Supabase URL / publishable key, либо нажато «Сохранить параметры облака» без них |
| Ошибка записи задач, RLS | профиль не активен: привяжите Telegram (шаг 4.4). Проверьте блок 4 в `verify.sql`: `access_status` должен быть `active` |
| Письмо подтверждения не приходит | исчерпан лимит бесплатного SMTP. Отключите «Confirm email» (шаг 2.5) или подождите час |
| Бот молчит | выполните шаг 3.2: если в `last_error_message` ошибка, переставьте webhook с тем же `secret_token`, что в Edge Secrets |
| Функция отвечает `401`/`Unauthorized` | `verify_jwt` не отключён: деплойте командой `supabase functions deploy` из корня проекта (там, где `supabase/config.toml`) |
| Cron пишет `failed` | `CRON_SECRET` в Vault не совпадает с Edge Secret, либо в URL задания чужой project-ref. Пересоздайте задание (шаг 2.14) |
| Напоминания приходят дважды | в `cron.job` больше одного задания с этим именем: удалите лишние и создайте одно |
| Уведомления Windows не появляются | в настройках приложения режим уведомлений не должен быть «Только Telegram»; проверьте, что приложение запущено (значок в трее) |
| Время напоминаний сдвинуто | проверьте часовой пояс: **Настройки → Расписание → Часовой пояс** (он же уходит в облако и определяет дайджест) |
| Автообновление не находит версию | в `package.json` `build.publish.owner/repo` не совпадают с репозиторием, либо репозиторий приватный |
| `supabase: command not found` | CLI не установлен: шаг 2.8, либо используйте `npx supabase` |

---

## Часть 7. Что дальше

Порядок, в котором предлагаю дорабатывать:

1. **Интерфейс.** Это главное: сейчас это аккуратная, но «инженерная» заготовка. Нужно решить, как должен выглядеть ваш трекер: оставить тёмную тему или сделать светлую; плотные строки или просторные карточки; нужны ли боковые колонки; какие шрифты и акценты. Самый быстрый путь — пришлите 1–2 скриншота или ссылки на референсы (Todoist, TickTick, Things, Linear, что нравится) и список того, что раздражает в текущем виде. Соберу на этом основе новый интерфейс.
2. **Календарь на неделю.** Сетка «пн–вс» с задачами по дням, перетаскивание задачи на другой день.
3. **Drag & drop сортировка.** Ручной порядок внутри дня (`sort_order` в схеме уже есть), приоритет над автоматической сортировкой по сроку.
4. **Подзадачи.** Нужно решить, как их хранить: как отдельные задачи со ссылкой на родителя (проще и работает в боте) или как чек-лист внутри задачи (компактнее в интерфейсе). От этого зависит миграция.
5. **Мелочи по ходу:** шаблоны задач, массовые операции, статистика, поиск в боте.
