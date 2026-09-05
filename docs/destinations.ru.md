[English](destinations.md) · [Русский](destinations.ru.md)

# Подключение площадки

У площадки две половины, и они разделены намеренно: Studio должна знать, что
площадка есть, и держать ключи к ней. Никто не спрашивает ключи к площадке, куда
вы не публикуете.

```bash
# 1. Сказать Studio, что площадка есть
docker compose exec app bun /app/ops/cli.js channel-connect --target threads_en

# 2. Спросить, чего ей не хватает
docker compose exec app bun /app/ops/cli.js doctor
```

`doctor` называет ровно те настройки, которых площадке недостаёт, и никогда не
печатает те, что уже есть. Впишите deployment credentials в `.env`,
перезапустите сервис и повторите проверку. Само направление можно включить в
Command Center → Studio → Каналы, Telegram → Настройки → Каналы, через CLI или
одноимённую MCP-операцию. Host credentials и интерактивный вход в Telegram
Stories остаются CLI-only: MCP не получает секрет и локальную сессию.

Command Center и Telegram показывают рядом с каждым каналом `готов` либо число
недостающих credentials. Отключить канал можно там же или через
`channel-disable` / `ops_channel_disable`; отключённый маршрут исчезает из целей
черновика, а история публикаций остаётся.

## Что можно подключить

Текстовые площадки подключаются по имени цели, видео-аккаунты — по площадке и
языку.

| Площадка | Чем подключить | Что нужно |
| --- | --- | --- |
| Сайт | `--target site_ru` / `site_en` | ничего, плюс `docker compose exec app bun /app/ops/cli.js studio-profile-set --site-enabled` |
| Telegram-канал | Каналы или `--target telegram` | `CONTROLLER_BOT_TOKEN` |
| Discord | Каналы или `--target discord` | `DISCORD_CHANNEL_ID`, затем CLI `credential-set --target discord` |
| Threads | Каналы или `connect-link --platform threads` | native app credentials либо сохранённый ключ Zernio |
| X | Каналы или `connect-link --platform x` | `X_CLIENT_ID`, `X_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY` — это **OAuth 2.0** Client ID и Client Secret из раздела «User authentication settings» приложения в X developer portal. Не API Key и API Secret с той же страницы: те относятся к OAuth 1.0a, а подключение идёт по OAuth 2.0 с PKCE. Там же пропишите callback URL `https://ваш-домен/oauth/x`. |
| Instagram Stories | Включить Story в Каналах после native-входа Instagram либо выбрать её маршрут Zernio | native credentials Instagram либо сохранённый ключ Zernio |
| Telegram Stories | Каналы или `--target telegram_stories` | CLI `telegram-stories-login` с `TELEGRAM_CHANNEL_STORIES_API_ID`, `_API_HASH`, `_SESSION` |
| YouTube | Каналы или `connect-link --platform youtube --locale ru` | `YOUTUBE_*_CLIENT_ID`, `_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY` |
| Instagram лента и Reels | Каналы или `connect-link --platform instagram` | native credentials Instagram либо сохранённый ключ Zernio |
| TikTok | `--platform tiktok --provider zernio` | сохранённый ключ Zernio — только аналитика, публикации нет |

## Что несёт каждая площадка

| Площадка | Текст | Медиа | Короткие видео | Аналитика |
| --- | :---: | :---: | :---: | :---: |
| Сайт | ✓ | ✓ | — | ✓ |
| Telegram-канал | ✓ | ✓ | — | ✓ |
| Telegram Stories | — | ✓ | ✓ | — |
| X | ✓ | ✓ | — | ✓ |
| Threads | ✓ | ✓ | — | ✓ |
| YouTube Shorts | — | — | ✓ | ✓ |
| Instagram Reels / Stories | — | ✓ | ✓ | ✓ |

Solo Publisher использует ваши собственные аккаунты и API credentials и не
становится посредником между вами и аудиторией.

## Нативно или через провайдера

Площадки Meta достижимы двумя путями, и канал помнит, каким именно он
пользуется. Для native-доставки создайте своё приложение Meta и положите его id
и secret в `.env`; Instagram требует Professional-аккаунт. Один раз создайте
`TOKEN_ENCRYPTION_KEY` командой `openssl rand -hex 32`.

Зарегистрируйте в Dashboard приложения точные callback URL:

```text
https://ваш-домен.example/oauth/threads
https://ваш-домен.example/oauth/instagram
```

После этого откройте Command Center → Studio → Каналы или Telegram → Настройки →
Каналы и нажмите native-кнопку RU либо EN. Браузер вернётся в Studio, она сама
обменяет code, запечатает долгоживущий токен в БД и сохранит account id. Вход в
Instagram включает Reels; отдельную цель Stories включите на том же экране,
только если эта Studio публикует Stories. Копировать URL, запускать CLI, менять
token в `.env` и перезапускать сервис больше не нужно. Development mode работает
для аккаунтов, которым назначена роль в приложении; Meta review нужен, когда
приложение начинает подключать чужие аккаунты.

```bash
# Та же площадка, но доставка через провайдера
docker compose exec app bun /app/ops/cli.js channel-connect --target threads_en --provider zernio --account-id <id>
```

Такому каналу нужен один ключ Zernio вместо токенов площадки — и для ленты,
и для Threads, и для Stories, — и `doctor` спросит именно его. Ключ не живёт
в `.env`: он проверяется в Zernio и хранится запечатанным в базе этой Studio,
как и OAuth-токен.

```bash
printf %s "$ZERNIO_KEY" | docker compose exec -T app bun /app/ops/cli.js credential-set --target zernio
```

Command Center и Telegram → Настройки → Каналы показывают публикационные
маршруты найденных у провайдера аккаунтов: нужный можно выбрать вместо ручного
ввода id. MCP получает тот же список через
`studio_zernio_connection_options`, выбранный маршрут подключается через
`ops_channel_connect`.

Нативный путь остаётся по умолчанию: площадка, которую не несёт провайдер,
доставляется прямо на платформу, как и раньше.

## YouTube

Единственная площадка с проводником, потому что получение первого токена — это
шаг, на котором люди застревают.

**Приложение создаёте вы, а не мы.** Квота YouTube считается на проект Google
Cloud, а не на пользователя: общий клиент дал бы всем установкам вместе
несколько загрузок в сутки, а публикация от вашего имени из нашего проекта
потребовала бы верификации Google.

1. Создайте проект в [Google Cloud](https://console.cloud.google.com/) и
   включите **YouTube Data API v3**.
2. Настройте OAuth consent screen и переведите статус публикации в
   **In production**. Оставить *Testing* — та самая ловушка: Google тогда выдаёт
   refresh-токены, [истекающие через 7 дней](https://developers.google.com/identity/protocols/oauth2),
   то есть публикация заработает и молча встанет неделю спустя. Для собственного
   канала верификация Google не нужна, предупреждение «unverified app» ожидаемо.
3. На consent screen добавьте скоуп
   `https://www.googleapis.com/auth/youtube.force-ssl`. Это единственный скоуп,
   который принимают и `videos.insert`, и `commentThreads.list`, — одно
   разрешение и публикует, и читает комментарии к опубликованному.
4. Credentials → OAuth client ID → тип **Web application**, в authorized
   redirect URI — `https://<ваш домен>/oauth/youtube`, тот же `PUBLIC_BASE_URL`,
   на котором работает Studio. Тип *TVs and Limited Input devices* не подойдёт:
   его поток принимает только `auth/youtube` и `auth/youtube.readonly`, а
   `force-ssl` отвергает — и канал будет исправно загружать видео, не собрав ни
   одного комментария.
5. Впишите id и secret в `.env` как `YOUTUBE_RU_CLIENT_ID` и
   `YOUTUBE_RU_CLIENT_SECRET` (либо `YOUTUBE_EN_*`).

```bash
docker compose exec app bun /app/ops/cli.js connect-link --platform youtube --locale ru
```

Команда отвечает ссылкой на consent screen Google. Подтвердите там — Google
вернёт браузер в Studio, и она закончит сама: refresh-токен ляжет запечатанным
в её базу, канал появится в реестре, ничего не нужно вписывать в `.env` и
перезапускать. Ту же операцию можно начать в Studio → Каналы и в
Telegram-боте: один поток, три поверхности. Это подтверждение —
единственный ручной шаг, и он делается один раз: дальше Studio сама меняет
refresh-токен на короткоживущий access-токен перед каждой загрузкой, а сам
refresh-токен не истекает, если вы не отзовёте доступ и не оставите приложение
неиспользуемым полгода.

## Threads

Учтите, что у приложения Meta с use case Threads **две** пары id и секрета.
Нужна пара Threads — App settings → Basic, поля **Threads App ID** и **Threads
App secret**. Если подставить id самого приложения Meta, Meta вернёт ошибку
4476002, из которой не следует, какую из двух пар она хотела.

Подключение — из Studio → Каналы, как описано выше. Если Command Center
недоступен — сломанный деплой, Studio без публичного сайта, — тот же обмен
выполняется из терминала:

```bash
docker compose exec -it app bun /app/ops/cli.js threads-authorize --locale ru
```

Команда печатает ссылку для подтверждения тем аккаунтом, от имени которого вы
публикуете. Meta сделает редирект на колбэк, и тот **сообщит, что подключение не
удалось — на этом пути так и должно быть**: у ссылки нет подписанного state,
поэтому колбэк её отклоняет и не тратит одноразовый код. Скопируйте адрес
целиком из адресной строки и вставьте обратно — команда обменяет его и напечатает
токен для `.env`.

## Что стоит знать заранее

**Токены Meta протухают, и Studio продлевает их сама.** Долгоживущие токены
Instagram и Threads истекают через 60 дней после выпуска. Укажите в `.env`
`TOKEN_ENCRYPTION_KEY`, и Studio будет продлевать их сама за месяц до срока,
сохраняя каждое продление запечатанным — база ежедневно уезжает копией, а живой
токен не та вещь, которую стоит передавать в чат. Нет ключа — нет продления:
токены остаются ровно тем, что написано в `.env`, и перевыпускать их придётся
руками.

Одного она за вас не сделает. Уже истёкший токен продлить нельзя, поэтому
Studio, выключенную на два месяца, придётся подключить заново — из Studio →
Каналы, теми же двумя кликами. У аккаунта, подключённого так, учётные данные
живут в базе, и правка `THREADS_*_ACCESS_TOKEN` в `.env` их не заменит; при
старте в лог пишется предупреждение, если эти два значения разошлись. Для
аккаунта, который через браузер не подключали, `.env` по-прежнему главный.
Подключение через провайдера снимает вопрос целиком.

**Не оставляйте приложение Meta в режиме разработки.** Такое приложение
публикует только в аккаунты, у которых есть роль в нём, — своей Studio хватает,
чужому аккаунту нет. Переключите его в live в App Dashboard, прежде чем
подключать аккаунт, которым не управляете.

**X берёт деньги за запись.** Четыре ключа получить несложно, но публикация
через API X требует платного тарифа их платформы для разработчиков.

**Telegram Stories публикует пользователь, а не бот.** Создайте api id и hash на
[my.telegram.org](https://my.telegram.org) в разделе *API development tools*,
впишите их в `.env` вместе с путём для сессии и войдите один раз:

```bash
docker compose exec -it app bun /app/ops/cli.js telegram-stories-login
```

Команда спросит номер телефона, код от Telegram и пароль двухфакторной защиты,
если он есть, а затем скажет, какому аккаунту теперь принадлежит сессия. Сессия —
это каталог, в который пишет приложение, поэтому вход выполняется внутри
контейнера; `-it` обязателен, это диалог.

**Видео больше 50 МБ требует локального Bot API.** Публичный API Telegram не
отдаёт файлы крупнее. Укажите в `.env` `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` и
`COMPOSE_PROFILES=telegram`, чтобы поднять его рядом с приложением и увеличить
предел до 2 ГБ.
