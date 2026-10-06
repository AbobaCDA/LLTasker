# Forge Tasks — настройка по шагам

**Сейчас вы здесь:** Часть 1 — сборка релиза идёт во вкладке **Actions**. Как только в **Releases**
появится `Forge-Tasks-Setup-0.1.0.exe` — переходите к **Части 2 (Supabase)**. Ниже видно, что уже закрыто.

| Часть | Статус |
| --- | --- |
| 0. Подготовка (аккаунты, бот у BotFather) | сделано |
| 1. Гит и первая сборка | код в `AbobaCDA/LLTasker`, сборка запущена |
| 2. Supabase: база, функции, расписание | **следующий шаг** |
| 3. Telegram: webhook, владелец, команды | после части 2 |
| 4. Приложение: облако, аккаунт, привязка бота | после части 3 |
| 5–7. Чек-лист, диагностика, планы по интерфейсу | в конце |


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

- [ ] **1.1.** Создайте репозиторий: GitHub → **New repository** → имя `LLTasker` → **Public** → без README и .gitignore (они уже есть в проекте).
  Почему public: автообновление в приложении скачивает релиз анонимно. С приватным репозиторием обновления не заработают без токена внутри приложения.
- [ ] **1.2.** Проверьте, что репозиторий существует и запомните его точное имя: откройте
  [github.com/settings/profile](https://github.com/settings/profile) — поле **Username** (не «Name»:
  оно может быть с пробелами и русскими буквами) — и список репозиториев
  [github.com](https://github.com) → «Your repositories».
  Владелец проекта — `AbobaCDA`, репозиторий — `LLTasker`: `https://github.com/AbobaCDA/LLTasker.git`.

- [ ] **1.3.** Откройте терминал в папке проекта и инициализируйте репозиторий. Команды ниже работают и в CMD, и в PowerShell — логин вписывается прямо в адрес:

```bash
cd C:\Users\Mike\Desktop\Tasker\forge-tasks

git init
git add .
git commit -m "Forge Tasks: каркас таск-трекера"
git branch -M main
git remote add origin "https://github.com/AbobaCDA/LLTasker.git"   # имя репозитория — как на GitHub
```

> Переменные у оболочек разные: `$login = "..."` понимает только PowerShell, в CMD будет ошибка
> «"$login" не является внутренней или внешней командой». Поэтому проще вписать логин в адрес.
> Если переменная всё же нужна — откройте PowerShell (`Win+X` → «Терминал») или наберите `powershell` прямо в CMD.

- [ ] **1.3.1.** Убедитесь, что в папке есть `package-lock.json` — файл со списком версий зависимостей:

```bash
dir package-lock.json
```

Он обязателен: сборка в GitHub Actions использует `npm ci`, который работает только при наличии этого файла,
и без него workflow падает за 15–20 секунд. В архиве проекта файл есть; если его нет, создайте:

```bash
npm install --package-lock-only
```

- [ ] **1.4.** Проверьте адрес перед отправкой — эта команда отличает «неправильный адрес» от «неправильной авторизации»:

```bash
git remote -v          # должно быть https://github.com/AbobaCDA/LLTasker.git для fetch и push
git ls-remote origin   # пусто и без ошибки = репозиторий найден
```

> **Важно про копирование.** Адрес нельзя копировать из отформатированного текста (чат, просмотр документации):
> вместе с ним легко утащить markdown-разметку, и тогда в `git remote -v` появится
> `[https://github.com/AbobaCDA/LLTasker.git](https://github.com/AbobaCDA/LLTasker.git)` — со скобками.
> Git воспримет скобки как часть имени репозитория и ответит `Repository not found`.
> Набирайте адрес вручную или копируйте из адресной строки браузера на странице своего репозитория.
> Если разметка уже попала в remote — запустите `tools\fix-git-remote.cmd` или выполните:
> `git remote remove origin` и `git remote add origin https://github.com/AbobaCDA/LLTasker.git`.

Если `git ls-remote` отвечает `Repository not found` — имя репозитория другое, либо он не создан (шаг 1.1). Если `origin` добавлен с ошибкой, исправьте адрес: `git remote set-url origin "https://github.com/AbobaCDA/LLTasker.git"`.

- [ ] **1.5.** Отправьте код:

```bash
git push -u origin main
```

- [ ] **1.6.** Проверьте на GitHub, что код на месте. Вкладка **Actions** должна показать workflow «Build and publish Windows release» — он пока не запускается, это правильно: сборка идёт по тегу.
- [ ] **1.7.** Проверьте `package.json`, раздел `build.publish` — от него зависит адрес автообновления:

```json
"publish": [
  { "provider": "github", "owner": "AbobaCDA", "repo": "LLTasker", "releaseType": "release" }
]
```

Здесь всё уже верно: `owner` — `AbobaCDA`, `repo` — `LLTasker`. Менять ничего не нужно, если только вы не переименуете репозиторий на GitHub.

```powershell
На всякий случай сверьтесь со страницей репозитория: имя в адресной строке браузера и в поле `repo` должны совпадать.

- [ ] **1.8.** Убедитесь, что репозиторий **публичный** — на его странице рядом с названием стоит «Public».
  С приватным автообновление не работает: приложение скачивает релиз анонимно.
  Сменить видимость: **Settings → General → внизу Danger Zone → Change repository visibility → Make public**.

- [ ] **1.9.** Выпустите первую версию: тег должен точно совпадать с `version` в `package.json` (`0.1.0` → `v0.1.0`):

```powershell
git tag v0.1.0
git push origin v0.1.0
```

- [ ] **1.10.** Дождитесь сборки (5–10 минут, вкладка **Actions** → клик по запуску → логи). В конце в разделе **Releases** появится `Forge-Tasks-Setup-0.1.0.exe` и файлы `latest.yml`, `.blockmap` — по ним работает автообновление.

**Если сборка упала.** Откройте **Actions** → клик по запуску → слева задача `release` → раскрыть шаг
с красным крестиком: там написана причина. Две самые частые:

| Что в логе | Причина | Что делать |
| --- | --- | --- |
| Падение за 15–20 секунд, `Error: Dependencies lock file is not found in D:\a\…` | файла `package-lock.json` нет **в том коммите, на который указывает тег** | шаг «Как добавить lock-файл в репозиторий» ниже: создать файл, закоммитить, переставить тег |
| `npm ci can only install with an existing package-lock.json` | то же самое, но на шаге установки | то же |
| `Тег v… не совпадает с версией …` | тег и `version` в `package.json` разошлись | удалите тег и создайте заново на нужной версии (команды ниже) |

**Как добавить lock-файл в репозиторий.** Важно: тег указывает на конкретный коммит, поэтому файл
нужно не просто создать, а закоммитить **до** тега. Проверьте три вещи:

```bash
dir package-lock.json            # 1. файл создан локально? Если нет — npm install --package-lock-only
git ls-files package-lock.json   # 2. файл отслеживается гитом? Пустой вывод = нет, нужно git add
git log --oneline -1 v0.1.0      # 3. на каком коммите стоит тег (hash сравните с git log -1)
```

Затем коммит и отправка:

```bash
git add -A
git status                       # в списке должен быть package-lock.json
git commit -m "Добавляю package-lock.json"
git push
```

**Перезапуск сборки после правок** — теги неизменяемы, поэтому старый удаляем и ставим заново:

```bash
git add -A
git commit -m "Правки перед сборкой"
git push

git push origin :refs/tags/v0.1.0   # удаляем старый тег на GitHub
git tag -d v0.1.0 2>$null || true   # и локально (в CMD: git tag -d v0.1.0)
git tag v0.1.0
git push origin v0.1.0              # запускает сборку заново
```

Альтернатива без тегов: **Actions → Build and publish Windows release → Run workflow**. Этот запуск идёт
без проверки тега, но публикация релиза ориентируется на версию из `package.json`, поэтому такой способ
годится для проверки, что сборка вообще проходит, а не для выпуска релиза.

**Как читать лог сборки.** Шаги по порядку и что они значат:

1. `Install dependencies` — установка пакетов;
2. `Run tests` — 151 проверка; красный означает проблему в коде, а не в окружении;
3. `Build NSIS package` — сборка установщика (здесь ошибки electron-builder, например про права);
4. `Upload build artifacts to the run` — собранные файлы прикладываются к запуску, их можно скачать даже без релиза;
5. `Publish release` — публикация во вкладке Releases через `gh`.

Если шаг 3 или 5 упал, файлы всё равно лежат в артефактах запуска (шаг 4). Скачайте оттуда `.exe` и `latest.yml`
и приложите к релизу вручную: **Releases → Draft a new release** → тег `v0.1.0` → загрузить файлы.

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

> Команды этой части — для **PowerShell**, а не CMD: в CMD не работает `Invoke-RestMethod`.
> Открыть PowerShell: `Win+X` → «Терминал», либо набрать `powershell` в уже открытом CMD.

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
| В логе `electron-builder version=26.5.0` вместо `26.15.3` | сработал `npm audit fix --force`, он понижает сборщик. Верните в `package.json` `"electron-builder": "26.15.3"`, затем `npm install` |
| Сборка падает за 15–20 секунд, `Dependencies lock file is not found` | нет `package-lock.json` в коммите под тегом: создайте файл, закоммитьте, пересоздайте тег |
| В логе `• publishing publisher=Github (owner: X, project: Y)` и затем `404 Not Found` на `api.github.com/repos/X/Y/releases` | в `package.json` (`build.publish.repo`) указан не тот репозиторий, куда вы пушите. Должно быть `owner: AbobaCDA`, `repo: LLTasker` — сверьте со страницей репозитория |
| Сборка дошла до публикации и упала с трейсом `PublishManager.awaitTasks` | у встроенного публикатора electron-builder нет прав или релиз с этим тегом уже существует. Обновите workflow: публикация идёт через `gh release` |
| В логе публикации `403 Forbidden` / `Resource not accessible by integration` | у токена нет прав на запись: в workflow нужен блок `permissions: contents: write` (есть в актуальной версии файла) |
| В логе публикации `422 Validation Failed` / `already_exists` | релиз с тегом уже создан (в том числе пустой от прошлой попытки). Новый workflow обновит существующий релиз через `gh release upload --clobber` |
| Релиз опубликован, но файлов в нём нет | смотрите артефакты запуска: **Actions → запуск → Artifacts → forge-tasks-…** — там лежат `.exe`, `latest.yml`, `.blockmap`; их можно приложить к релизу вручную |
| Сборка падает на шаге сборки с 404 при публикации | `build.publish.repo` в `package.json` не совпадает с именем репозитория на GitHub (должно быть `LLTasker`) |
| Автообновление не находит версию | `build.publish.repo` в `package.json` не совпадает с именем репозитория, либо репозиторий приватный |
| `git push` пишет `Repository not found` | в адресе remote мусор (скобки, кавычки, плейсхолдер) или репозиторий ещё не создан: `git remote -v` покажет реальный адрес; исправляется через `git remote set-url origin "https://github.com/AbobaCDA/LLTasker.git"` |
| `git push` просит пароль | GitHub не принимает пароль аккаунта. Создайте токен: [github.com/settings/tokens](https://github.com/settings/tokens) → Generate new token (classic) → scope `repo` → вставьте его вместо пароля. Обычно на Windows достаточно войти в открывшемся окне браузера |
| `git push` отклонён: `rejected non-fast-forward` | при создании репозитория добавили README. Выполните `git pull --rebase origin main`, затем `git push -u origin main` |
| `supabase: command not found` | CLI не установлен: шаг 2.8, либо используйте `npx supabase` |

---

## Часть 7. Что дальше

Порядок, в котором предлагаю дорабатывать:

1. **Интерфейс.** Это главное: сейчас это аккуратная, но «инженерная» заготовка. Нужно решить, как должен выглядеть ваш трекер: оставить тёмную тему или сделать светлую; плотные строки или просторные карточки; нужны ли боковые колонки; какие шрифты и акценты. Самый быстрый путь — пришлите 1–2 скриншота или ссылки на референсы (Todoist, TickTick, Things, Linear, что нравится) и список того, что раздражает в текущем виде. Соберу на этом основе новый интерфейс.
2. **Календарь на неделю.** Сетка «пн–вс» с задачами по дням, перетаскивание задачи на другой день.
3. **Drag & drop сортировка.** Ручной порядок внутри дня (`sort_order` в схеме уже есть), приоритет над автоматической сортировкой по сроку.
4. **Подзадачи.** Нужно решить, как их хранить: как отдельные задачи со ссылкой на родителя (проще и работает в боте) или как чек-лист внутри задачи (компактнее в интерфейсе). От этого зависит миграция.
5. **Мелочи по ходу:** шаблоны задач, массовые операции, статистика, поиск в боте.
