[English](README.md) · [Русский](README.ru.md)

# Solo Publisher

**Пишите в чате. Публикуйте везде. Владейте всей системой.**

Пишите из Telegram или MCP-клиента вроде Codex, а Solo Publisher публикует на
ваш сайт, в Telegram, X, Threads, YouTube Shorts и Instagram, ставит в
расписание и независимо повторяет доставку в каждый канал, а затем собирает
аналитику обратно. Один владелец, один сервер, без SaaS-посредника.

![Рабочая публикация, созданная через Solo Publisher](docs/assets/live-site-ru.png)

> Это не стартовый шаблон и не макет. Так работает вся production-система
> публикации живого, ежедневно обновляемого издания.

## Установка

Нужны Docker и домен, DNS которого уже указывает на эту машину:

```bash
curl -fsSL https://raw.githubusercontent.com/alexgetmancom/solo-publisher/main/install.sh | sh -s -- publisher.example.com
```

Скрипт проверяет Docker и DNS до того, как что-то изменит, генерирует секреты,
поднимает стек, получает TLS-сертификат и печатает ссылку на Command Center
вместе с токеном. Повторный запуск обновляет установку.
→ [Руководство по установке](docs/install.ru.md)

## Попробовать без установки

Понадобятся [Bun 1.3.14](https://bun.sh/) и нативные зависимости для сборки
`sharp`:

```bash
bun install --frozen-lockfile
bun run demo
```

Публичная лента Studio — <http://localhost:8788/api/public/site>: тестовые
данные, без ключей, остановка по `Ctrl+C`.

## Документация

- [Установка, обновление, запуск из исходников](docs/install.ru.md)
- [Подключение площадки](docs/destinations.ru.md) — каждая платформа, что ей нужно и что аукнется позже
- [Резервные копии](docs/backups.ru.md) — что приходит само, а на что направить свой инструмент
- [Управление из агента](docs/mcp.ru.md) — MCP-транспорт и подключение клиента
- [Архитектура, стек, разработка](docs/architecture.ru.md)

## Лицензия

[Apache License 2.0](LICENSE).
